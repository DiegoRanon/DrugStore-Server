import type { FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis } from "../../src/db/redis.js";
import {
  FailingPlacesProvider,
  setPlacesProvider,
} from "../../src/integrations/geocoding/index.js";
import {
  FailingTravelTimeProvider,
  setTravelTimeProvider,
} from "../../src/integrations/traveltime/index.js";
import {
  FailingOptimizer,
  setRouteOptimizer,
  type EstimateResult,
  type OptimizeRequest,
  type OptimizeResult,
  type RouteOptimizer,
} from "../../src/integrations/routing/index.js";
import {
  createTestApp,
  createWorld,
  markReady,
  request,
  type TestWorld,
} from "../helpers/fixtures.js";

/**
 * The Route Optimizer feature end to end: standardized addresses in,
 * a sequence out, and every degradation path in between.
 *
 * The behaviours pinned here are the ones that are cheap to break and
 * expensive to notice — a stop silently dropped because it had no
 * coordinates, a time window an hour out, an admin optimizing another
 * organization's driver, or the priority rule quietly losing to the solver.
 */

let app: FastifyInstance;
let world: TestWorld;

const DATE = "2026-09-15";

/** Somewhere in Montreal; the exact spot only matters for being distinct. */
const MONTREAL = { latitude: 45.5019, longitude: -73.5674 };

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  world = await createWorld(app);
});

afterEach(() => {
  setRouteOptimizer(null);
  setPlacesProvider(null);
  setTravelTimeProvider(null);
});

/**
 * Records what the optimizer was asked, and answers with a fixed order.
 *
 * Most of what matters about this feature is in the *request* — whether
 * coordinates arrived, whether the time window is the right interval, whether
 * priority was passed. Asserting on the response alone would miss all of it.
 */
class SpyOptimizer implements RouteOptimizer {
  readonly name = "spy";
  requests: OptimizeRequest[] = [];

  constructor(private readonly order?: (stops: OptimizeRequest["stops"]) => string[]) {}

  async optimize(request: OptimizeRequest): Promise<OptimizeResult> {
    this.requests.push(request);
    return {
      orderedOrderIds: this.order
        ? this.order(request.stops)
        : request.stops.map((s) => s.orderId),
      degraded: false,
      provider: this.name,
    };
  }

  async estimate(request: OptimizeRequest): Promise<EstimateResult> {
    return {
      estimates: request.stops.map((stop, index) => ({
        orderId: stop.orderId,
        distanceMeters: (index + 1) * 1000,
        durationSeconds: (index + 1) * 120,
      })),
      degraded: false,
      provider: this.name,
    };
  }
}

async function createOrder(overrides: Record<string, unknown> = {}) {
  const res = await request(app, {
    method: "POST",
    url: "/v1/orders",
    token: world.orgA.adminToken,
    payload: {
      client_id: world.orgA.clientId,
      driver_id: world.orgA.driverId,
      delivery_date: DATE,
      delivery_window: "AM",
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return markReady(app, world.orgA.adminToken, res.json().id);
}

/** A geocoded order, offset so each one is a distinguishable location. */
async function createStop(index: number, overrides: Record<string, unknown> = {}) {
  return createOrder({
    address: `${100 + index} Test St`,
    place_id: `place-${index}`,
    formatted_address: `${100 + index} Test St, Montréal, QC, Canada`,
    latitude: MONTREAL.latitude + index * 0.01,
    longitude: MONTREAL.longitude + index * 0.01,
    ...overrides,
  });
}

function optimizeAsAdmin(payload: Record<string, unknown> = {}) {
  return request(app, {
    method: "POST",
    url: "/v1/orders/route/optimize",
    token: world.orgA.adminToken,
    payload: { date: DATE, driver_id: world.orgA.driverId, ...payload },
  });
}

function optimizeAsDriver(payload: Record<string, unknown> = {}) {
  return request(app, {
    method: "POST",
    url: "/v1/driver/queue/optimize",
    token: world.orgA.driverToken,
    payload: { date: DATE, ...payload },
  });
}

describe("coordinates reach the optimizer", () => {
  it("sends the stored geocode rather than the address string", async () => {
    const spy = new SpyOptimizer();
    setRouteOptimizer(spy);

    await createStop(1);
    await createStop(2);

    expect((await optimizeAsAdmin()).statusCode).toBe(200);

    const [sent] = spy.requests;
    expect(sent!.stops).toHaveLength(2);
    for (const stop of sent!.stops) {
      expect(stop.location).toBeDefined();
      expect(stop.location!.latitude).toBeCloseTo(MONTREAL.latitude, 1);
    }
  });

  it("persists the order it was given as sequence_number", async () => {
    const first = await createStop(1);
    const second = await createStop(2);
    const third = await createStop(3);

    // Reverse of creation order, so a passing assertion cannot be the
    // insertion order wearing a disguise.
    setRouteOptimizer(
      new SpyOptimizer(() => [third.id, second.id, first.id]),
    );

    const res = await optimizeAsAdmin();
    expect(res.statusCode).toBe(200);

    const rows = await db("orders")
      .whereIn("id", [first.id, second.id, third.id])
      .select("id", "sequence_number");
    const positions = new Map(rows.map((r) => [r.id, r.sequence_number]));

    expect(positions.get(third.id)).toBe(1);
    expect(positions.get(second.id)).toBe(2);
    expect(positions.get(first.id)).toBe(3);
  });
});

describe("stops without coordinates", () => {
  it("appends them instead of dropping them", async () => {
    const geocoded = await createStop(1);
    // A hand-typed rural address Google does not know. Still a package in the
    // van, so it must survive the round trip.
    const typed = await createOrder({ address: "Rang 4, Saint-Isidore" });

    const spy = new SpyOptimizer();
    setRouteOptimizer(spy);

    const res = await optimizeAsAdmin();
    expect(res.statusCode).toBe(200);

    // It was offered to the provider, with no location attached...
    const sentTyped = spy.requests[0]!.stops.find((s) => s.orderId === typed.id);
    expect(sentTyped).toBeDefined();
    expect(sentTyped!.location).toBeUndefined();

    // ...reported as unroutable so staff can fix the address...
    expect(res.json().unroutable_order_ids).toEqual([typed.id]);

    // ...and still present in the driver's day.
    const ids = res.json().orders.map((o: { id: string }) => o.id);
    expect(ids).toContain(typed.id);
    expect(ids).toContain(geocoded.id);
  });

  it("does not report a fully geocoded day as unroutable", async () => {
    setRouteOptimizer(new SpyOptimizer());
    await createStop(1);
    await createStop(2);

    const res = await optimizeAsAdmin();
    expect(res.json().unroutable_order_ids).toEqual([]);
  });
});

describe("time windows", () => {
  it("passes an explicit range through as the stop's window", async () => {
    const spy = new SpyOptimizer();
    setRouteOptimizer(spy);

    const ranged = await createStop(1, {
      requested_time_start: "14:00",
      requested_time_end: "16:00",
    });
    await createStop(2);

    await optimizeAsAdmin();

    const stop = spy.requests[0]!.stops.find((s) => s.orderId === ranged.id);
    expect(stop!.timeWindow).toBeDefined();
    // 2026-09-15 is EDT (UTC-4), so 14:00 local is 18:00Z.
    expect(stop!.timeWindow!.start).toBe("2026-09-15T18:00:00.000Z");
    expect(stop!.timeWindow!.end).toBe("2026-09-15T20:00:00.000Z");
  });

  it("falls back to the organization's AM window", async () => {
    const spy = new SpyOptimizer();
    setRouteOptimizer(spy);

    await createStop(1, { delivery_window: "AM" });
    await createStop(2);

    await optimizeAsAdmin();

    // Default org hours are 09:00–12:00 local, i.e. 13:00–16:00Z in September.
    expect(spy.requests[0]!.stops[0]!.timeWindow).toEqual({
      start: "2026-09-15T13:00:00.000Z",
      end: "2026-09-15T16:00:00.000Z",
    });
  });

  it("applies the admin's run-level range only where nothing was promised", async () => {
    const spy = new SpyOptimizer();
    setRouteOptimizer(spy);

    const promised = await createStop(1, { requested_delivery_time: "09:30" });
    const unpromised = await createStop(2);

    await optimizeAsAdmin({ time_range: { start: "13:00", end: "15:00" } });

    const sent = spy.requests[0]!.stops;
    const promisedWindow = sent.find((s) => s.orderId === promised.id)!.timeWindow!;
    const overriddenWindow = sent.find((s) => s.orderId === unpromised.id)!.timeWindow!;

    // The patient was told 09:30 — the admin narrowing the run to the
    // afternoon must not re-promise that delivery.
    expect(promisedWindow.start).toBe("2026-09-15T13:00:00.000Z");
    expect(overriddenWindow.start).toBe("2026-09-15T17:00:00.000Z");
  });

  it("rejects a range that ends before it starts", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/orders",
      token: world.orgA.adminToken,
      payload: {
        client_id: world.orgA.clientId,
        delivery_date: DATE,
        delivery_window: "AM",
        requested_time_start: "16:00",
        requested_time_end: "14:00",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects half a range", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/orders",
      token: world.orgA.adminToken,
      payload: {
        client_id: world.orgA.clientId,
        delivery_date: DATE,
        delivery_window: "AM",
        requested_time_start: "14:00",
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("priority still outranks the optimizer", () => {
  it("puts a flagged stop first no matter what the solver returned", async () => {
    const first = await createStop(1);
    const second = await createStop(2);
    const urgent = await createStop(3, { is_priority: true });

    // The solver puts the urgent stop last — geographically it may well be.
    setRouteOptimizer(
      new SpyOptimizer(() => [first.id, second.id, urgent.id]),
    );

    const res = await optimizeAsAdmin();
    expect(res.statusCode).toBe(200);

    // The product rule wins: a pharmacist flagging a stop urgent means it
    // goes first, even at the cost of kilometres.
    expect(res.json().orders[0].id).toBe(urgent.id);

    // And the driver sees the same thing, which is the whole point.
    const queue = await request(app, {
      method: "GET",
      url: `/v1/driver/queue?date=${DATE}`,
      token: world.orgA.driverToken,
    });
    expect(queue.json().stops[0].id).toBe(urgent.id);
  });

  it("tells the optimizer which stops are priority", async () => {
    const spy = new SpyOptimizer();
    setRouteOptimizer(spy);

    const urgent = await createStop(1, { is_priority: true });
    await createStop(2);

    await optimizeAsAdmin();

    const sent = spy.requests[0]!.stops.find((s) => s.orderId === urgent.id);
    expect(sent!.isPriority).toBe(true);
  });
});

describe("degradation", () => {
  it("keeps the previous order when the provider fails", async () => {
    setRouteOptimizer(new FailingOptimizer());

    await createStop(1);
    await createStop(2);

    const res = await optimizeAsAdmin();

    // A driver holding packages needs a list far more than an optimal one.
    expect(res.statusCode).toBe(200);
    expect(res.json().degraded).toBe(true);
    expect(res.json().orders).toHaveLength(2);
  });

  it("still writes a sequence when it degrades", async () => {
    setRouteOptimizer(new FailingOptimizer());
    await createStop(1);
    await createStop(2);

    await optimizeAsAdmin();

    const rows = await db("orders")
      .where({ driver_id: world.orgA.driverId, delivery_date: DATE })
      .orderBy("sequence_number");
    expect(rows.map((r) => r.sequence_number)).toEqual([1, 2]);
  });

  it("does not flag a route degraded merely because estimates are missing", async () => {
    // `degraded` means "this is your previous order, not the optimizer's
    // answer". An adapter that can order but not measure gave a good route.
    const spy = new SpyOptimizer();
    spy.estimate = async () => ({
      estimates: [],
      degraded: true,
      provider: "spy",
    });
    setRouteOptimizer(spy);

    await createStop(1);
    await createStop(2);

    const res = await optimizeAsAdmin();
    expect(res.json().degraded).toBe(false);
    expect(res.json().estimates).toBeUndefined();
  });

  it("returns estimates when the provider can measure", async () => {
    setRouteOptimizer(new SpyOptimizer());
    await createStop(1);
    await createStop(2);

    const res = await optimizeAsAdmin();
    expect(res.json().estimates).toHaveLength(2);
    expect(res.json().estimates[0].distance_meters).toBe(1000);
  });
});

describe("admin and driver reach the same route", () => {
  it("produces the same sequence from either entry point", async () => {
    const first = await createStop(1);
    const second = await createStop(2);

    setRouteOptimizer(new SpyOptimizer(() => [second.id, first.id]));

    const admin = await optimizeAsAdmin();
    const adminOrder = admin.json().orders.map((o: { id: string }) => o.id);

    const driver = await optimizeAsDriver();
    const driverOrder = driver.json().stops.map((s: { id: string }) => s.id);

    expect(driverOrder).toEqual(adminOrder);
    expect(driverOrder).toEqual([second.id, first.id]);
  });

  it("refuses a driver token on the admin route endpoint", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/orders/route/optimize",
      token: world.orgA.driverToken,
      payload: { date: DATE, driver_id: world.orgA.driverId },
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses to optimize a driver from another organization", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/orders/route/optimize",
      token: world.orgA.adminToken,
      payload: { date: DATE, driver_id: world.orgB.driverId },
    });

    // Indistinguishable from a driver that does not exist — a 403 here would
    // confirm the id belongs to someone.
    expect(res.statusCode).toBe(404);
  });
});

describe("coordinates follow the privacy cliff", () => {
  it("gives them to a driver while the delivery is active", async () => {
    await createStop(1);

    const res = await request(app, {
      method: "GET",
      url: `/v1/driver/queue?date=${DATE}`,
      token: world.orgA.driverToken,
    });

    const stop = res.json().stops[0];
    expect(stop.latitude).toBeCloseTo(MONTREAL.latitude, 1);
    expect(stop.longitude).toBeDefined();
  });

  it("takes them away the moment the attempt is over", async () => {
    const stop = await createStop(1);
    await request(app, {
      method: "POST",
      url: `/v1/driver/orders/${stop.id}/pickup`,
      token: world.orgA.driverToken,
    });
    await request(app, {
      method: "POST",
      url: `/v1/driver/orders/${stop.id}/return`,
      token: world.orgA.driverToken,
      payload: { reason: "customer_absent" },
    });

    const res = await request(app, {
      method: "GET",
      url: `/v1/driver/queue?date=${DATE}`,
      token: world.orgA.driverToken,
    });

    // A returned order is not terminal — the package still owes the pharmacy
    // a handover — but the attempt is finished, so the address and everything
    // that resolves to it are gone. A coordinate is not an exception.
    const returned = res.json().to_return[0];
    expect(returned.id).toBe(stop.id);
    expect(returned.latitude).toBeUndefined();
    expect(returned.address).toBeUndefined();
  });
});

describe("address standardization", () => {
  it("suggests addresses and resolves one to coordinates", async () => {
    const suggestions = await request(app, {
      method: "GET",
      url: "/v1/places/autocomplete?q=Notre-Dame&session_token=session-1",
      token: world.orgA.adminToken,
    });

    expect(suggestions.statusCode).toBe(200);
    const first = suggestions.json().data[0];
    expect(first.place_id).toBeDefined();

    const resolved = await request(app, {
      method: "GET",
      url: `/v1/places/${first.place_id}?session_token=session-1`,
      token: world.orgA.adminToken,
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().latitude).toBeCloseTo(45.5, 1);
    expect(resolved.json().formatted_address).toContain("Montréal");
  });

  it("returns no suggestions rather than an error when the provider is down", async () => {
    // An employee with a patient on the phone must still be able to take the
    // order; it simply saves without coordinates.
    setPlacesProvider(new FailingPlacesProvider());

    const res = await request(app, {
      method: "GET",
      url: "/v1/places/autocomplete?q=Notre-Dame&session_token=session-1",
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("fails loudly when a chosen address cannot be resolved", async () => {
    setPlacesProvider(new FailingPlacesProvider());

    const res = await request(app, {
      method: "GET",
      url: "/v1/places/anything?session_token=session-1",
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(503);
  });

  it("is closed to drivers", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/places/autocomplete?q=Notre-Dame&session_token=session-1",
      token: world.orgA.driverToken,
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("the geocode is snapshotted, like the address", () => {
  it("copies the patient's coordinates onto a new order", async () => {
    await db("clients").where({ id: world.orgA.clientId }).update({
      place_id: "place-client",
      formatted_address: "500 Client St, Montréal, QC, Canada",
      latitude: MONTREAL.latitude,
      longitude: MONTREAL.longitude,
      geocoded_at: new Date(),
    });

    const order = await createOrder();

    expect(order.latitude).toBeCloseTo(MONTREAL.latitude, 4);
    expect(order.place_id).toBe("place-client");
  });

  it("does not rewrite an existing order when the patient moves", async () => {
    await db("clients").where({ id: world.orgA.clientId }).update({
      place_id: "place-client",
      latitude: MONTREAL.latitude,
      longitude: MONTREAL.longitude,
    });

    const order = await createOrder();

    await request(app, {
      method: "PATCH",
      url: `/v1/clients/${world.orgA.clientId}`,
      token: world.orgA.adminToken,
      payload: {
        address: "999 Elsewhere Ave",
        place_id: "place-moved",
        latitude: 46.8139,
        longitude: -71.208,
      },
    });

    const row = await db("orders").where({ id: order.id }).first();
    // Last month's delivery went where it went.
    expect(row.place_id).toBe("place-client");
    expect(Number(row.latitude)).toBeCloseTo(MONTREAL.latitude, 4);
  });
});

describe("the driver's ETA for the rest of the run", () => {
  function eta(payload: Record<string, unknown> = {}) {
    return request(app, {
      method: "POST",
      url: "/v1/driver/queue/eta",
      token: world.orgA.driverToken,
      payload: { date: DATE, ...payload },
    });
  }

  /** Puts the stops in the van, which is where an ETA is asked for. */
  async function pickUp(...ids: string[]) {
    for (const id of ids) {
      await request(app, {
        method: "POST",
        url: `/v1/driver/orders/${id}/pickup`,
        token: world.orgA.driverToken,
      });
    }
  }

  async function geocodePharmacy() {
    await db("organizations")
      .where({ id: world.orgA.id })
      .update({ latitude: MONTREAL.latitude, longitude: MONTREAL.longitude });
  }

  it("chains the pharmacy to the first stop, then stop to stop", async () => {
    await geocodePharmacy();
    const first = await createStop(1);
    const second = await createStop(2);
    await pickUp(first.id, second.id);

    const res = await eta();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toBe(false);
    expect(body.origin).toBe("pharmacy");
    expect(body.stops).toHaveLength(2);

    // Each arrival is strictly after the one before it: the chain is walked
    // in order, and a later stop can never be reached earlier.
    const arrivals = body.stops.map((s: { arrival_time: string }) =>
      Date.parse(s.arrival_time),
    );
    expect(arrivals[1]).toBeGreaterThan(arrivals[0]!);
    expect(Date.parse(body.finish_time)).toBeGreaterThan(arrivals[1]!);
  });

  it("counts time at the door, so finishing is later than the last arrival", async () => {
    await geocodePharmacy();
    const only = await createStop(1);
    await pickUp(only.id);

    const body = (await eta()).json();

    // A driver asking when they are done is not asking when they pull up.
    expect(Date.parse(body.finish_time)).toBeGreaterThan(
      Date.parse(body.stops[0].arrival_time),
    );
  });

  it("reports the stop order it was given, never a better one", async () => {
    await geocodePharmacy();
    const first = await createStop(1);
    const second = await createStop(2);
    const urgent = await createStop(3, { is_priority: true });
    await pickUp(first.id, second.id, urgent.id);

    setRouteOptimizer(new SpyOptimizer(() => [first.id, second.id, urgent.id]));
    await optimizeAsAdmin();

    const body = (await eta()).json();

    // The queue sorts priority first, so that is the chain the ETA measures.
    // An ETA that quietly re-sequenced would disagree with the list above it.
    const queue = await request(app, {
      method: "GET",
      url: `/v1/driver/queue?date=${DATE}`,
      token: world.orgA.driverToken,
    });

    expect(body.stops.map((s: { order_id: string }) => s.order_id)).toEqual(
      queue.json().stops.map((s: { id: string }) => s.id),
    );
    expect(body.stops[0].order_id).toBe(urgent.id);
  });

  it("re-measures a shorter chain once a stop is delivered", async () => {
    await geocodePharmacy();
    const first = await createStop(1);
    const second = await createStop(2);
    await pickUp(first.id, second.id);

    const before = (await eta()).json();
    expect(before.stops).toHaveLength(2);

    await request(app, {
      method: "POST",
      url: `/v1/driver/orders/${before.stops[0].order_id}/complete`,
      token: world.orgA.driverToken,
    });

    const after = (await eta()).json();

    // The delivered stop is gone from the chain, and the run is shorter.
    expect(after.stops).toHaveLength(1);
    expect(after.stops[0].order_id).not.toBe(before.stops[0].order_id);
    expect(after.total_duration_seconds).toBeLessThan(
      before.total_duration_seconds,
    );
  });

  it("re-measures after a return, the same as after a delivery", async () => {
    await geocodePharmacy();
    const first = await createStop(1);
    const second = await createStop(2);
    await pickUp(first.id, second.id);

    const before = (await eta()).json();

    await request(app, {
      method: "POST",
      url: `/v1/driver/orders/${before.stops[0].order_id}/return`,
      token: world.orgA.driverToken,
      payload: { reason: "customer_absent" },
    });

    const after = (await eta()).json();
    expect(after.stops).toHaveLength(1);
  });

  it("leaves an ungeocoded stop out of the chain without dropping it", async () => {
    await geocodePharmacy();
    const geocoded = await createStop(1);
    const typed = await createOrder({ address: "Rang 4, Saint-Isidore" });
    await pickUp(geocoded.id, typed.id);

    const body = (await eta()).json();

    expect(body.stops.map((s: { order_id: string }) => s.order_id)).toEqual([
      geocoded.id,
    ]);
    // Reported rather than silently missing, so the app can say the estimate
    // covers less than the whole list.
    expect(body.unestimated_order_ids).toEqual([typed.id]);
    expect(body.degraded).toBe(false);
  });

  it("degrades to no estimate when the provider is down", async () => {
    await geocodePharmacy();
    const only = await createStop(1);
    await pickUp(only.id);

    setTravelTimeProvider(new FailingTravelTimeProvider());

    const res = await eta();

    // Never an error, and never a zero — a driver would read "0 min" as done.
    expect(res.statusCode).toBe(200);
    expect(res.json().degraded).toBe(true);
    expect(res.json().stops).toEqual([]);
  });

  it("degrades when the pharmacy has no coordinate to start from", async () => {
    // No geocodePharmacy() here: a chain that starts nowhere cannot be walked,
    // and measuring from stop one would under-report the whole run.
    const only = await createStop(1);
    await pickUp(only.id);

    expect((await eta()).json().degraded).toBe(true);
  });

  it("handles an empty run without inventing a finish time", async () => {
    await geocodePharmacy();

    const body = (await eta()).json();
    expect(body.degraded).toBe(true);
    expect(body.stops).toEqual([]);
  });

  it("is closed to an admin token", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/driver/queue/eta",
      token: world.orgA.adminToken,
      payload: { date: DATE },
    });

    expect(res.statusCode).toBe(403);
  });
});
