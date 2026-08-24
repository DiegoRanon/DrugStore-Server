import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis } from "../../src/db/redis.js";
import {
  createTestApp,
  createWorld,
  markReady,
  request,
  type TestWorld,
} from "../helpers/fixtures.js";

/**
 * The pharmacy's actual sequence, from the client's domain workflow.
 *
 * An order is taken by phone days ahead and sits in a calendar only the admin
 * can see. On the day, staff physically pack the bags and declare it ready —
 * and only then does it exist as far as the driver is concerned. The failure
 * this prevents is concrete: a driver arriving at the counter for an order
 * nobody has packed, because the app told them it was waiting.
 */

let app: FastifyInstance;
let world: TestWorld;

const DATE = "2026-09-20";

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

function driver(
  url: string,
  payload?: unknown,
  method: "GET" | "POST" = "POST",
) {
  return request(app, { method, url, token: world.orgA.driverToken, payload });
}

function admin(
  url: string,
  payload?: unknown,
  method: "GET" | "POST" | "PATCH" = "POST",
) {
  return request(app, { method, url, token: world.orgA.adminToken, payload });
}

describe("the scheduled stage", () => {
  it("creates orders into the admin calendar, not onto the counter", async () => {
    const order = await createOrder();
    expect(order.status).toBe("scheduled");
    expect(order.ready_at).toBeNull();
  });

  it("hides a scheduled order from its own assigned driver", async () => {
    // Pre-assigning tomorrow's run in the calendar must not put the order in
    // the driver's queue today.
    await createOrder();

    const queue = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");
    expect(queue.statusCode).toBe(200);
    expect(queue.json().stops).toHaveLength(0);
    expect(queue.json().closed).toHaveLength(0);
    expect(queue.json().to_return).toHaveLength(0);
  });

  it("refuses a pickup with a 404, not a state error", async () => {
    const order = await createOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/pickup`);

    /*
     * Note this is stricter than the state machine's own answer, which is
     * ORDER_NOT_READY (see the unit suite). Two layers refuse this, and the
     * outer one wins:
     *
     *   - The repository cuts scheduled rows out of every driver query, so the
     *     row is never found and the request 404s.
     *   - The state machine would have said "not ready yet" if it had been.
     *
     * The 404 is the behaviour we want at the API edge. The calendar is
     * "visible uniquement par l'Admin", and a distinguishable 422 would confirm
     * to a driver that an order exists on a day they cannot see.
     */
    expect(res.statusCode).toBe(404);
  });

  it("keeps a scheduled order unreachable on every driver route", async () => {
    const order = await createOrder();

    for (const [url, payload] of [
      [`/v1/driver/orders/${order.id}/priority`, { is_priority: true }],
      [`/v1/driver/orders/${order.id}/complete`, undefined],
      [`/v1/driver/orders/${order.id}/handover`, undefined],
      [
        `/v1/driver/orders/${order.id}/payment`,
        { payment_method: "cash", amount_collected: 1 },
      ],
    ] as const) {
      const res = await driver(url, payload);
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("lets the admin see and edit it in the calendar", async () => {
    const order = await createOrder();

    const patched = await admin(
      `/v1/orders/${order.id}`,
      { delivery_window: "PM", requested_delivery_time: "14:30" },
      "PATCH",
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.json().delivery_window).toBe("PM");
    expect(patched.json().requested_delivery_time).toBe("14:30:00");
  });

  it("counts it on the calendar endpoint without returning any patient data", async () => {
    await createOrder();
    await createOrder();

    const res = await admin(
      `/v1/orders/calendar?from=${DATE}&to=${DATE}`,
      undefined,
      "GET",
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().days).toEqual([
      { delivery_date: DATE, total: 2, by_status: { scheduled: 2 } },
    ]);
    // The whole point of an aggregate: a month of badges must not ship a month
    // of addresses.
    expect(res.body).not.toContain("alpha Patient");
    expect(res.body).not.toContain("100 alpha Street");
  });

  it("does not audit-log the calendar read", async () => {
    await createOrder();
    await admin(`/v1/orders/calendar?from=${DATE}&to=${DATE}`, undefined, "GET");

    const rows = await db("access_audit_log");
    expect(rows).toHaveLength(0);
  });
});

describe("declaring an order ready", () => {
  it("moves it onto the counter and stamps ready_at", async () => {
    const order = await createOrder();
    const ready = await admin(`/v1/orders/${order.id}/ready`);

    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("in_pharmacy");
    expect(ready.json().ready_at).not.toBeNull();
  });

  it("makes it visible to the driver", async () => {
    const order = await createOrder();
    await markReady(app, world.orgA.adminToken, order.id);

    const queue = await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET");
    expect(queue.json().stops).toHaveLength(1);
    expect(queue.json().stops[0].id).toBe(order.id);
  });

  it("refuses a driver declaring the pharmacy's own counter ready", async () => {
    const order = await createOrder();
    const res = await driver(`/v1/orders/${order.id}/ready`);
    // Admin-only route: the driver token is refused before the state machine.
    expect(res.statusCode).toBe(403);
  });

  it("cannot be declared ready twice", async () => {
    const order = await createOrder();
    await markReady(app, world.orgA.adminToken, order.id);

    const again = await admin(`/v1/orders/${order.id}/ready`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ORDER_INVALID_TRANSITION");
  });

  it("records both stages in the status timeline", async () => {
    const order = await createOrder();
    await markReady(app, world.orgA.adminToken, order.id);

    const detail = await admin(`/v1/orders/${order.id}`, undefined, "GET");
    expect(
      detail.json().status_events.map((e: { status: string }) => e.status),
    ).toEqual(["scheduled", "in_pharmacy"]);
  });

  it("offers the transitions the dashboard renders its buttons from", async () => {
    const order = await createOrder();

    const scheduled = await admin(`/v1/orders/${order.id}`, undefined, "GET");
    expect(scheduled.json().available_transitions.sort()).toEqual([
      "cancel",
      "mark_ready",
    ]);

    await markReady(app, world.orgA.adminToken, order.id);
    const ready = await admin(`/v1/orders/${order.id}`, undefined, "GET");
    expect(ready.json().available_transitions.sort()).toEqual([
      "cancel",
      "pickup",
    ]);
  });
});

describe("cancelling", () => {
  it("cancels straight out of the calendar", async () => {
    const order = await createOrder();
    const res = await admin(`/v1/orders/${order.id}/cancel`);

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");
    expect(res.json().cancelled_at).not.toBeNull();
  });

  it("still cancels an order already on the counter", async () => {
    const order = await createOrder();
    await markReady(app, world.orgA.adminToken, order.id);

    const res = await admin(`/v1/orders/${order.id}/cancel`);
    expect(res.json().status).toBe("cancelled");
  });
});

describe("the full happy path", () => {
  it("walks scheduled -> ready -> picked up -> completed with payment", async () => {
    const order = await createOrder({ amount_due: 42.5 });
    await markReady(app, world.orgA.adminToken, order.id);

    const pickedUp = await driver(`/v1/driver/orders/${order.id}/pickup`);
    expect(pickedUp.statusCode).toBe(200);
    expect(pickedUp.json().status).toBe("picked_up");

    const completed = await driver(`/v1/driver/orders/${order.id}/complete`, {
      payment: { payment_method: "cash", amount_collected: 42.5 },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.status).toBe("completed");
    expect(row.payment_collected).toBe(true);
    expect(row.payment_status).toBe("paid");
    expect(row.amount_collected).toBe(42.5);
    expect(row.payment_method).toBe("cash");
    // Every stage stamped, in order.
    expect(row.ready_at).not.toBeNull();
    expect(row.picked_up_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
  });
});
