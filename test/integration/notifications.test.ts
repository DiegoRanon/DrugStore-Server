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
 * "Le livreur recoit une notification et la commande apparait dans la section
 *  en pharmacie" — and mid-shift, "le livreur … reste à l'affut des commandes
 *  pouvant être ajouter par la pharmacie durant son shift."
 *
 * The failure this prevents: a driver finishing their run and going home while
 * a bag the pharmacy added at 3pm is still on the counter. There is no push
 * provider here; these rows plus the queue's has_new flag are what the app
 * polls.
 */

let app: FastifyInstance;
let world: TestWorld;

const DATE = "2026-09-25";

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
      delivery_date: DATE,
      delivery_window: "AM",
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

function admin(
  url: string,
  payload?: unknown,
  method: "GET" | "POST" | "PATCH" = "POST",
) {
  return request(app, { method, url, token: world.orgA.adminToken, payload });
}

function driver(
  url: string,
  payload?: unknown,
  method: "GET" | "POST" = "POST",
  token = world.orgA.driverToken,
) {
  return request(app, { method, url, token, payload });
}

describe("what raises a notification", () => {
  it("tells the assigned driver when staff declare an order ready", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    await markReady(app, world.orgA.adminToken, order.id);

    const rows = await db("driver_notifications").where({
      driver_id: world.orgA.driverId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("order_ready");
    expect(rows[0].order_id).toBe(order.id);
    expect(rows[0].delivery_date).toBe(DATE);
  });

  it("stays quiet while the order is still only in the calendar", async () => {
    // Dispatch planning tomorrow's run should not buzz anyone today.
    const order = await createOrder();
    await admin(`/v1/orders/${order.id}/assign`, {
      driver_id: world.orgA.driverId,
    });

    expect(await db("driver_notifications")).toHaveLength(0);
  });

  it("tells a driver about an order added to their run mid-shift", async () => {
    const order = await createOrder();
    await markReady(app, world.orgA.adminToken, order.id);

    await admin(`/v1/orders/${order.id}/assign`, {
      driver_id: world.orgA.driverId,
    });

    const rows = await db("driver_notifications").where({
      driver_id: world.orgA.driverId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("order_assigned");
  });

  it("tells both drivers when work moves between them", async () => {
    const [colleague] = await db("users")
      .insert({
        organization_id: world.orgA.id,
        role: "driver",
        email: "colleague@alpha.test",
        password_hash: "x",
        first_name: "Colleague",
        last_name: "Driver",
      })
      .returning(["id"]);

    const order = await createOrder({ driver_id: world.orgA.driverId });
    await markReady(app, world.orgA.adminToken, order.id);
    await db("driver_notifications").delete();

    await admin(`/v1/orders/${order.id}/assign`, { driver_id: colleague.id });

    const rows = await db("driver_notifications").orderBy("driver_id");
    expect(rows).toHaveLength(2);

    const byDriver = new Map(rows.map((r) => [r.driver_id, r.type]));
    // The one losing it needs to know as much as the one gaining it — they may
    // already have the bag in hand.
    expect(byDriver.get(world.orgA.driverId)).toBe("order_unassigned");
    expect(byDriver.get(colleague.id)).toBe("order_assigned");
  });

  it("tells the driver when an order they were holding is cancelled", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    await markReady(app, world.orgA.adminToken, order.id);
    await db("driver_notifications").delete();

    await admin(`/v1/orders/${order.id}/cancel`);

    const rows = await db("driver_notifications");
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("order_cancelled");
  });
});

describe("reading the feed", () => {
  async function readyOrderForDriver() {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    return markReady(app, world.orgA.adminToken, order.id);
  }

  it("lists the driver's notifications newest first with an unread count", async () => {
    await readyOrderForDriver();
    await readyOrderForDriver();

    const res = await driver("/v1/driver/notifications", undefined, "GET");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(2);
    expect(res.json().unread_count).toBe(2);
  });

  it("carries no patient details", async () => {
    await readyOrderForDriver();
    const res = await driver("/v1/driver/notifications", undefined, "GET");

    // The order id is a handle the driver resolves through their own queue,
    // which applies the usual scoping and the usual PII rules.
    expect(res.body).not.toContain("alpha Patient");
    expect(res.body).not.toContain("100 alpha Street");
    expect(res.body).not.toContain("5145550111");
  });

  it("marks the whole feed read when no ids are given", async () => {
    await readyOrderForDriver();
    await readyOrderForDriver();

    const res = await driver("/v1/driver/notifications/read");
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(2);

    const after = await driver("/v1/driver/notifications", undefined, "GET");
    expect(after.json().unread_count).toBe(0);
  });

  it("marks only the named notifications read", async () => {
    await readyOrderForDriver();
    await readyOrderForDriver();

    const feed = (
      await driver("/v1/driver/notifications", undefined, "GET")
    ).json();

    const res = await driver("/v1/driver/notifications/read", {
      ids: [feed.data[0].id],
    });
    expect(res.json().updated).toBe(1);

    const unread = await driver(
      "/v1/driver/notifications?unread=true",
      undefined,
      "GET",
    );
    expect(unread.json().data).toHaveLength(1);
    expect(unread.json().unread_count).toBe(1);
  });

  it("never shows one driver another driver's feed", async () => {
    await readyOrderForDriver();

    const res = await driver(
      "/v1/driver/notifications",
      undefined,
      "GET",
      world.orgB.driverToken,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
    expect(res.json().unread_count).toBe(0);
  });

  it("cannot be marked read by someone else", async () => {
    await readyOrderForDriver();
    const feed = (
      await driver("/v1/driver/notifications", undefined, "GET")
    ).json();

    const res = await driver(
      "/v1/driver/notifications/read",
      { ids: [feed.data[0].id] },
      "POST",
      world.orgB.driverToken,
    );
    expect(res.json().updated).toBe(0);

    const mine = await driver("/v1/driver/notifications", undefined, "GET");
    expect(mine.json().unread_count).toBe(1);
  });

  it("surfaces the unread count on the queue the app already polls", async () => {
    await readyOrderForDriver();

    const queue = await driver(
      `/v1/driver/queue?date=${DATE}`,
      undefined,
      "GET",
    );
    expect(queue.json().unread_notifications).toBe(1);
  });
});

describe("noticing a change without a push provider", () => {
  it("reports has_new when something moved since the last poll", async () => {
    const first = await driver(
      `/v1/driver/queue?date=${DATE}`,
      undefined,
      "GET",
    );
    expect(first.json().has_new).toBe(false);
    expect(first.json().last_updated_at).toBeNull();

    const order = await createOrder({ driver_id: world.orgA.driverId });
    await markReady(app, world.orgA.adminToken, order.id);

    const second = await driver(
      `/v1/driver/queue?date=${DATE}&updated_since=1970-01-01T00:00:00.000Z`,
      undefined,
      "GET",
    );
    expect(second.json().has_new).toBe(true);
    expect(second.json().last_updated_at).not.toBeNull();
  });

  it("reports nothing new when the driver is already up to date", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    await markReady(app, world.orgA.adminToken, order.id);

    const first = (
      await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET")
    ).json();

    const second = await driver(
      `/v1/driver/queue?date=${DATE}&updated_since=${encodeURIComponent(
        first.last_updated_at,
      )}`,
      undefined,
      "GET",
    );
    expect(second.json().has_new).toBe(false);
  });
});
