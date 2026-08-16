import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis } from "../../src/db/redis.js";
import {
  createTestApp,
  createWorld,
  request,
  type TestWorld,
} from "../helpers/fixtures.js";

/**
 * PRD §3: driver mutations accept an `Idempotency-Key` because the app runs on
 * flaky mobile networks and retries. The failure this prevents is concrete —
 * a retried "complete" writing a second status event, or a retried payment
 * recording a second collection.
 */

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
  return res.json();
}

function driverCall(
  url: string,
  options: { key?: string; payload?: unknown; token?: string } = {},
) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${options.token ?? world.orgA.driverToken}`,
      ...(options.key ? { "idempotency-key": options.key } : {}),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

describe("idempotent retries", () => {
  it("replays the original response instead of transitioning twice", async () => {
    const order = await createOrder();
    await driverCall(`/v1/driver/orders/${order.id}/pickup`);

    const first = await driverCall(`/v1/driver/orders/${order.id}/complete`, {
      key: "retry-me",
    });
    const second = await driverCall(`/v1/driver/orders/${order.id}/complete`, {
      key: "retry-me",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.headers["idempotent-replay"]).toBe("true");

    // The real proof: the audit trail has one completion, not two.
    const events = await db("order_status_events").where({
      order_id: order.id,
      status: "completed",
    });
    expect(events).toHaveLength(1);
  });

  it("without a key, the retry hits the state machine and is refused", async () => {
    const order = await createOrder();
    await driverCall(`/v1/driver/orders/${order.id}/pickup`);
    await driverCall(`/v1/driver/orders/${order.id}/complete`);

    const retry = await driverCall(`/v1/driver/orders/${order.id}/complete`);

    // Still safe, but the client sees an error rather than its own result —
    // which is exactly why the header exists.
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe("ORDER_ALREADY_TERMINAL");
  });

  it("does not record a payment twice", async () => {
    const order = await createOrder({ amount_due: 25 });
    await driverCall(`/v1/driver/orders/${order.id}/pickup`);

    const payload = { payment_method: "cash", amount_collected: 25 };
    const first = await driverCall(`/v1/driver/orders/${order.id}/payment`, {
      key: "pay-once",
      payload,
    });
    const second = await driverCall(`/v1/driver/orders/${order.id}/payment`, {
      key: "pay-once",
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.amount_collected).toBe(25);
    expect(row.payment_collected).toBe(true);
  });

  it("rejects the same key used for a different request", async () => {
    const order = await createOrder({ amount_due: 25 });
    await driverCall(`/v1/driver/orders/${order.id}/pickup`);

    await driverCall(`/v1/driver/orders/${order.id}/payment`, {
      key: "shared-key",
      payload: { payment_method: "cash", amount_collected: 25 },
    });

    const different = await driverCall(`/v1/driver/orders/${order.id}/payment`, {
      key: "shared-key",
      payload: { payment_method: "card", amount_collected: 999 },
    });

    // Replaying the earlier response here would silently do the wrong thing.
    expect(different.statusCode).toBe(409);
    expect(different.json().error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("treats key order in the body as insignificant", async () => {
    const order = await createOrder({ amount_due: 25 });
    await driverCall(`/v1/driver/orders/${order.id}/pickup`);

    const first = await driverCall(`/v1/driver/orders/${order.id}/payment`, {
      key: "same-meaning",
      payload: { payment_method: "cash", amount_collected: 25 },
    });
    const reordered = await driverCall(`/v1/driver/orders/${order.id}/payment`, {
      key: "same-meaning",
      payload: { amount_collected: 25, payment_method: "cash" },
    });

    expect(first.statusCode).toBe(200);
    expect(reordered.statusCode).toBe(200);
    expect(reordered.headers["idempotent-replay"]).toBe("true");
  });

  it("scopes keys per driver", async () => {
    const orderA = await createOrder();
    await driverCall(`/v1/driver/orders/${orderA.id}/pickup`, { key: "shared" });

    // Org B's driver reusing the same key string must not collide with, or
    // read, org A's stored response.
    const res = await driverCall(`/v1/driver/orders/${orderA.id}/pickup`, {
      key: "shared",
      token: world.orgB.driverToken,
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not cache a failed transition as a success", async () => {
    const order = await createOrder();

    const failed = await driverCall(`/v1/driver/orders/${order.id}/complete`, {
      key: "too-early",
    });
    expect(failed.statusCode).toBe(409);

    // A 4xx is a real outcome and replays as itself — the client's bug does
    // not become a different answer on retry.
    const retry = await driverCall(`/v1/driver/orders/${order.id}/complete`, {
      key: "too-early",
    });
    expect(retry.statusCode).toBe(409);
  });

  it("reuses a key whose reservation has expired", async () => {
    const order = await createOrder();
    await driverCall(`/v1/driver/orders/${order.id}/pickup`, { key: "aged" });

    await db("idempotency_keys")
      .where({ idempotency_key: "aged" })
      .update({ expires_at: new Date(Date.now() - 1000) });

    // The action is the same one from the driver's point of view; making them
    // invent a new key would be arbitrary.
    const res = await driverCall(`/v1/driver/orders/${order.id}/complete`, {
      key: "aged",
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects an oversized key", async () => {
    const order = await createOrder();
    const res = await driverCall(`/v1/driver/orders/${order.id}/pickup`, {
      key: "x".repeat(256),
    });
    expect(res.statusCode).toBe(400);
  });

  it("stores the response so a replay needs no re-execution", async () => {
    const order = await createOrder();
    await driverCall(`/v1/driver/orders/${order.id}/pickup`, { key: "stored" });

    const row = await db("idempotency_keys")
      .where({ idempotency_key: "stored" })
      .first();

    expect(row.completed_at).not.toBeNull();
    expect(row.response_status).toBe(200);
    expect(row.response_body).toBeTruthy();
  });
});
