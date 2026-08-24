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
 * Label verification at pickup.
 *
 * "Le livreur prends les commandes prête en vérifiant que les étiquettes
 *  correspondent aux commandes qu'il a sur son application en collaborant avec
 *  l'employé."
 *
 * order_packages carries a label code and a closed-enum package type and
 * nothing else. That is the point: the product constraint is "do not store
 * prescription or medical information", and a free-text line item is exactly
 * where a medication name would end up. The absence of a description column is
 * the control.
 */

let app: FastifyInstance;
let world: TestWorld;

const DATE = "2026-09-28";

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
) {
  return request(app, { method, url, token: world.orgA.driverToken, payload });
}

describe("recording what is in the order", () => {
  it("stores the label codes the employee printed", async () => {
    const order = await createOrder({
      packages: [
        { label_code: "4412-A" },
        { label_code: "4412-B", package_type: "cooler" },
      ],
    });

    expect(order.package_count).toBe(2);
    expect(order.packages).toEqual([
      expect.objectContaining({
        label_code: "4412-A",
        package_type: "bag",
        position: 1,
      }),
      expect.objectContaining({
        label_code: "4412-B",
        package_type: "cooler",
        position: 2,
      }),
    ]);
  });

  it("infers the cooler-bag requirement from the packages themselves", async () => {
    // Two facts that must never disagree: an order containing a cooler needs a
    // cooler bag, whatever the flag was set to.
    const order = await createOrder({
      requires_cooler_bag: false,
      packages: [{ label_code: "X-1", package_type: "cooler" }],
    });
    expect(order.requires_cooler_bag).toBe(true);
  });

  it("keeps an explicitly required cooler bag even with no packages listed", async () => {
    const order = await createOrder({ requires_cooler_bag: true });
    expect(order.requires_cooler_bag).toBe(true);
    expect(order.package_count).toBe(0);
  });

  it("refuses duplicate label codes on one order", async () => {
    // Two identical labels make the driver's check ambiguous at the counter.
    const res = await request(app, {
      method: "POST",
      url: "/v1/orders",
      token: world.orgA.adminToken,
      payload: {
        client_id: world.orgA.clientId,
        delivery_date: DATE,
        delivery_window: "AM",
        packages: [{ label_code: "SAME" }, { label_code: "same" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a package type outside the closed set", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/orders",
      token: world.orgA.adminToken,
      payload: {
        client_id: world.orgA.clientId,
        delivery_date: DATE,
        delivery_window: "AM",
        packages: [{ label_code: "X-1", package_type: "prescription" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("has nowhere to put a medication name", async () => {
    // The structural control, asserted. An extra field is stripped by the
    // schema rather than persisted, so there is no path from the dashboard to
    // a drug name in the database.
    await createOrder({
      packages: [{ label_code: "X-1", description: "Metformin 500mg" }],
    });

    const rows = await db("order_packages");
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).toEqual([
      "id",
      "order_id",
      "label_code",
      "package_type",
      "position",
      "created_at",
    ]);
    expect(JSON.stringify(rows)).not.toContain("Metformin");
  });
});

describe("editing the packages", () => {
  it("replaces the list while the order is still at the pharmacy", async () => {
    const order = await createOrder({ packages: [{ label_code: "OLD-1" }] });

    const res = await admin(
      `/v1/orders/${order.id}`,
      { packages: [{ label_code: "NEW-1" }, { label_code: "NEW-2" }] },
      "PATCH",
    );

    expect(res.statusCode).toBe(200);
    expect(
      res.json().packages.map((p: { label_code: string }) => p.label_code),
    ).toEqual(["NEW-1", "NEW-2"]);
    // Positions are rewritten contiguously, not left with a hole.
    expect(res.json().packages.map((p: { position: number }) => p.position)).toEqual([
      1, 2,
    ]);
  });

  it("still allows edits after the order is declared ready", async () => {
    const order = await createOrder({ packages: [{ label_code: "A" }] });
    await markReady(app, world.orgA.adminToken, order.id);

    const res = await admin(
      `/v1/orders/${order.id}`,
      { packages: [{ label_code: "A" }, { label_code: "B" }] },
      "PATCH",
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().package_count).toBe(2);
  });

  it("refuses edits once the driver holds the bags", async () => {
    const order = await createOrder({ packages: [{ label_code: "A" }] });
    await markReady(app, world.orgA.adminToken, order.id);
    await driver(`/v1/driver/orders/${order.id}/pickup`);

    const res = await admin(
      `/v1/orders/${order.id}`,
      { packages: [{ label_code: "B" }] },
      "PATCH",
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ORDER_NOT_EDITABLE");
  });
});

describe("the driver's pickup check", () => {
  it("shows the label codes on the stop", async () => {
    const order = await createOrder({
      packages: [{ label_code: "4412-A" }, { label_code: "4412-B" }],
    });
    await markReady(app, world.orgA.adminToken, order.id);

    const queue = (
      await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET")
    ).json();

    expect(queue.stops[0].package_count).toBe(2);
    expect(
      queue.stops[0].packages.map((p: { label_code: string }) => p.label_code),
    ).toEqual(["4412-A", "4412-B"]);
  });

  it("records the count the driver actually counted", async () => {
    const order = await createOrder({
      packages: [{ label_code: "A" }, { label_code: "B" }],
    });
    await markReady(app, world.orgA.adminToken, order.id);

    const res = await driver(`/v1/driver/orders/${order.id}/pickup`, {
      confirmed_package_count: 2,
    });
    expect(res.statusCode).toBe(200);

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.pickup_package_count).toBe(2);
  });

  it("accepts a count that disagrees with the order", async () => {
    // The physical bags on the counter are the truth, and a driver standing
    // there with the employee must not be blocked by the record. The mismatch
    // is recorded for the pharmacy to reconcile, not refused.
    const order = await createOrder({
      packages: [{ label_code: "A" }, { label_code: "B" }],
    });
    await markReady(app, world.orgA.adminToken, order.id);

    const res = await driver(`/v1/driver/orders/${order.id}/pickup`, {
      confirmed_package_count: 1,
    });
    expect(res.statusCode).toBe(200);

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.status).toBe("picked_up");
    expect(row.pickup_package_count).toBe(1);
  });

  it("still works with no body at all", async () => {
    // The count is optional; the app may ship the one-tap pickup unchanged.
    const order = await createOrder();
    await markReady(app, world.orgA.adminToken, order.id);

    const res = await driver(`/v1/driver/orders/${order.id}/pickup`);
    expect(res.statusCode).toBe(200);

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.pickup_package_count).toBeNull();
  });
});
