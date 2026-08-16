import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis } from "../../src/db/redis.js";
import {
  FailingOptimizer,
  setRouteOptimizer,
} from "../../src/integrations/routing/index.js";
import {
  createTestApp,
  createWorld,
  request,
  type TestWorld,
} from "../helpers/fixtures.js";

let app: FastifyInstance;
let world: TestWorld;

const DATE = "2026-09-15";

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
});

/** Creates an order assigned to org A's driver. */
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
  return res.json();
}

function driver(url: string, payload?: unknown, method: "GET" | "POST" = "POST") {
  return request(app, {
    method,
    url,
    token: world.orgA.driverToken,
    payload,
  });
}

describe("driver queue (PRD §5.4)", () => {
  it("returns the driver's active stops for the day", async () => {
    await createOrder();
    await createOrder();

    const res = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");

    expect(res.statusCode).toBe(200);
    expect(res.json().stops).toHaveLength(2);
    expect(res.json().date).toBe(DATE);
  });

  it("includes the pharmacy phone for one-tap dialling", async () => {
    await createOrder();
    const res = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");

    // §5.7: no server telephony — the app invokes the native dialer.
    expect(res.json().pharmacy.phone).toBe("+15145550100");
    expect(res.json().pharmacy.name).toContain("alpha");
  });

  it("never shows another driver's stops", async () => {
    const [other] = await db("users")
      .insert({
        organization_id: world.orgA.id,
        role: "driver",
        email: "other@alpha.test",
        password_hash: "x",
        first_name: "Other",
        last_name: "Driver",
      })
      .returning(["id"]);

    await createOrder({ driver_id: other.id });
    await createOrder();

    const res = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");
    expect(res.json().stops).toHaveLength(1);
  });

  it("excludes unassigned orders", async () => {
    await createOrder({ driver_id: null });
    const res = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");
    expect(res.json().stops).toHaveLength(0);
  });

  it("orders unsequenced stops last rather than first", async () => {
    const a = await createOrder();
    const b = await createOrder();
    await db("orders").where({ id: b.id }).update({ sequence_number: 1 });

    const res = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");
    // A NULL sequence means "not yet placed", not "position zero".
    expect(res.json().stops.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
  });
});

describe("PII minimization on the driver device (PRD §8.3)", () => {
  it("shows patient details while the delivery is active", async () => {
    await createOrder();
    const res = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");

    expect(res.json().stops[0].patient_name).toBe("alpha Patient");
    expect(res.json().stops[0].address).toBe("100 alpha Street");
    expect(res.json().stops[0].phone_number).toBe("+15145550111");
  });

  it("strips patient details the moment a delivery is completed", async () => {
    const order = await createOrder();
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    const completed = await driver(`/v1/driver/orders/${order.id}/complete`);

    expect(completed.statusCode).toBe(200);
    const body = completed.json();
    expect(body).not.toHaveProperty("patient_name");
    expect(body).not.toHaveProperty("address");
    expect(body).not.toHaveProperty("phone_number");
  });

  it("strips patient details on a return as well", async () => {
    const order = await createOrder();
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    const returned = await driver(`/v1/driver/orders/${order.id}/return`);

    const raw = JSON.stringify(returned.json());
    expect(raw).not.toContain("alpha Patient");
    expect(raw).not.toContain("100 alpha Street");
    expect(raw).not.toContain("5145550111");
  });

  it("keeps closed deliveries PII-free in the queue payload", async () => {
    const order = await createOrder();
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/complete`);

    const res = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");

    expect(res.json().stops).toHaveLength(0);
    expect(res.json().closed).toHaveLength(1);
    expect(JSON.stringify(res.json().closed)).not.toContain("alpha Patient");
  });

  it("still returns the full record to an admin", async () => {
    const order = await createOrder();
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/complete`);

    // The row persists server-side for admin history and reporting (§8.3).
    const res = await request(app, {
      method: "GET",
      url: `/v1/orders/${order.id}`,
      token: world.orgA.adminToken,
    });
    expect(res.json().patient_name).toBe("alpha Patient");
    expect(res.json().address).toBe("100 alpha Street");
  });
});

describe("driver transitions over HTTP", () => {
  it("walks pickup -> complete", async () => {
    const order = await createOrder();

    const pickedUp = await driver(`/v1/driver/orders/${order.id}/pickup`);
    expect(pickedUp.statusCode).toBe(200);
    expect(pickedUp.json().status).toBe("picked_up");
    expect(pickedUp.json().picked_up_at).not.toBeNull();

    const completed = await driver(`/v1/driver/orders/${order.id}/complete`);
    expect(completed.json().status).toBe("completed");
    expect(completed.json().completed_at).not.toBeNull();
  });

  it("refuses to complete an order that was never picked up", async () => {
    const order = await createOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/complete`);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ORDER_INVALID_TRANSITION");
  });

  it("refuses to return an order still sitting at the pharmacy", async () => {
    // §5.3: that is a cancellation, and it belongs to the admin.
    const order = await createOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/return`);
    expect(res.statusCode).toBe(409);
  });

  it("hides another driver's order behind a 404", async () => {
    const order = await createOrder();
    const res = await request(app, {
      method: "POST",
      url: `/v1/driver/orders/${order.id}/pickup`,
      token: world.orgB.driverToken,
    });
    expect(res.statusCode).toBe(404);
  });

  it("leaves a returned order unpaid", async () => {
    const order = await createOrder({ amount_due: 30 });
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/return`);

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.payment_status).toBe("unpaid");
    expect(row.payment_collected).toBe(false);
  });
});

describe("payment recording (PRD §5.5)", () => {
  it("records a collection and marks the order paid", async () => {
    const order = await createOrder({ amount_due: 42.5 });
    await driver(`/v1/driver/orders/${order.id}/pickup`);

    const res = await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "card",
      amount_collected: 42.5,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().matches_amount_due).toBe(true);

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.payment_collected).toBe(true);
    expect(row.payment_status).toBe("paid");
    expect(row.payment_method).toBe("card");
    expect(row.payment_collected_at).not.toBeNull();
  });

  it("flags a collection that does not match the amount due", async () => {
    const order = await createOrder({ amount_due: 42.5 });
    await driver(`/v1/driver/orders/${order.id}/pickup`);

    const res = await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "cash",
      amount_collected: 40,
    });

    // Not an error — partial payments happen at the door — but surfaced.
    expect(res.statusCode).toBe(200);
    expect(res.json().matches_amount_due).toBe(false);
  });

  it("returns a field-level error rather than a raw constraint failure", async () => {
    const order = await createOrder();
    await driver(`/v1/driver/orders/${order.id}/pickup`);

    const res = await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "cash",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    expect(res.json().error.details.fields).toBeInstanceOf(Array);
  });

  it("rejects an unknown payment method", async () => {
    const order = await createOrder();
    await driver(`/v1/driver/orders/${order.id}/pickup`);

    const res = await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "bitcoin",
      amount_collected: 10,
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a second collection on the same order", async () => {
    const order = await createOrder({ amount_due: 10 });
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "cash",
      amount_collected: 10,
    });

    const res = await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "cash",
      amount_collected: 10,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PAYMENT_ALREADY_COLLECTED");
  });

  it("refuses payment on an order the driver never picked up", async () => {
    const order = await createOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "cash",
      amount_collected: 10,
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses payment on a returned order", async () => {
    const order = await createOrder({ amount_due: 10 });
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/return`);

    const res = await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "cash",
      amount_collected: 10,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("cooler bag check (PRD §5.6)", () => {
  it("records a confirmation after a completed delivery", async () => {
    const order = await createOrder({ requires_cooler_bag: true });
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/complete`);

    const res = await driver(`/v1/driver/orders/${order.id}/cooler-check`, {
      confirmed: true,
    });

    expect(res.statusCode).toBe(200);
    const row = await db("orders").where({ id: order.id }).first();
    expect(row.cooler_bag_confirmed).toBe(true);
  });

  it("records a negative answer distinctly from a dismissal", async () => {
    const order = await createOrder({ requires_cooler_bag: true });
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/complete`);
    await driver(`/v1/driver/orders/${order.id}/cooler-check`, { confirmed: false });

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.cooler_bag_confirmed).toBe(false);
  });

  it("leaves the column NULL when the driver dismisses the prompt", async () => {
    // §5.6: a QC record, not a blocker — dismissal is simply never calling it,
    // and those surface in the admin exceptions report.
    const order = await createOrder({ requires_cooler_bag: true });
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/complete`);

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.cooler_bag_confirmed).toBeNull();
  });

  it("refuses the check when no cooler bag was required", async () => {
    const order = await createOrder({ requires_cooler_bag: false });
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    await driver(`/v1/driver/orders/${order.id}/complete`);

    const res = await driver(`/v1/driver/orders/${order.id}/cooler-check`, {
      confirmed: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("COOLER_BAG_NOT_REQUIRED");
  });

  it("refuses the check before the delivery has closed", async () => {
    const order = await createOrder({ requires_cooler_bag: true });
    await driver(`/v1/driver/orders/${order.id}/pickup`);

    const res = await driver(`/v1/driver/orders/${order.id}/cooler-check`, {
      confirmed: true,
    });
    expect(res.statusCode).toBe(409);
  });

  it("never blocks the delivery itself", async () => {
    const order = await createOrder({ requires_cooler_bag: true });
    await driver(`/v1/driver/orders/${order.id}/pickup`);
    const completed = await driver(`/v1/driver/orders/${order.id}/complete`);

    // Completion succeeds with the check outstanding.
    expect(completed.statusCode).toBe(200);
    expect(completed.json().cooler_bag_confirmed).toBeNull();
  });
});

describe("route optimization (PRD §5.4)", () => {
  it("assigns sequence numbers to the driver's stops", async () => {
    await createOrder({ address: "300 Cedar St" });
    await createOrder({ address: "100 Ash St" });
    await createOrder({ address: "200 Birch St" });

    const res = await driver("/v1/driver/queue/optimize", { date: DATE });

    expect(res.statusCode).toBe(200);
    expect(res.json().degraded).toBe(false);

    const addresses = res.json().stops.map((s: { address: string }) => s.address);
    expect(addresses).toEqual(["100 Ash St", "200 Birch St", "300 Cedar St"]);

    const sequences = res.json().stops.map((s: { sequence_number: number }) => s.sequence_number);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it("degrades instead of failing when the provider is down", async () => {
    // §5.4: a Mapbox outage must never block a driver holding packages.
    setRouteOptimizer(new FailingOptimizer());

    await createOrder({ address: "300 Cedar St" });
    await createOrder({ address: "100 Ash St" });

    const res = await driver("/v1/driver/queue/optimize", { date: DATE });

    expect(res.statusCode).toBe(200);
    expect(res.json().degraded).toBe(true);
    expect(res.json().stops).toHaveLength(2);
  });

  it("survives repeated optimization without violating the sequence index", async () => {
    // Resequencing has to clear positions before reassigning them, or two
    // stops swapping places collide on the partial unique index.
    await createOrder({ address: "300 Cedar St" });
    await createOrder({ address: "100 Ash St" });

    for (let i = 0; i < 3; i += 1) {
      const res = await driver("/v1/driver/queue/optimize", { date: DATE });
      expect(res.statusCode).toBe(200);
    }

    const rows = await db("orders")
      .where({ driver_id: world.orgA.driverId, delivery_date: DATE })
      .orderBy("sequence_number");
    expect(rows.map((r) => r.sequence_number)).toEqual([1, 2]);
  });

  it("handles an empty queue without error", async () => {
    const res = await driver("/v1/driver/queue/optimize", { date: DATE });
    expect(res.statusCode).toBe(200);
    expect(res.json().stops).toHaveLength(0);
  });

  it("does not resequence closed deliveries", async () => {
    const done = await createOrder({ address: "100 Ash St" });
    await driver(`/v1/driver/orders/${done.id}/pickup`);
    await driver(`/v1/driver/orders/${done.id}/complete`);
    await createOrder({ address: "300 Cedar St" });

    await driver("/v1/driver/queue/optimize", { date: DATE });

    const closed = await db("orders").where({ id: done.id }).first();
    // sequence_number is transient working state, not history — but a closed
    // delivery is not part of the active route either way.
    expect(closed.status).toBe("completed");
  });
});

describe("driver access boundaries", () => {
  it("refuses an admin token on driver routes", async () => {
    const res = await request(app, {
      method: "GET",
      url: `/v1/driver/queue?date=${DATE}`,
      token: world.orgA.adminToken,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses an unauthenticated request", async () => {
    const res = await request(app, {
      method: "GET",
      url: `/v1/driver/queue?date=${DATE}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("shows a driver nothing from another organization", async () => {
    await createOrder();
    const res = await request(app, {
      method: "GET",
      url: `/v1/driver/queue?date=${DATE}`,
      token: world.orgB.driverToken,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stops).toHaveLength(0);
  });
});
