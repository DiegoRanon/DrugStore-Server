import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis } from "../../src/db/redis.js";
import { OrdersService } from "../../src/modules/orders/service.js";
import {
  createTestApp,
  createWorld,
  request,
  type TestWorld,
} from "../helpers/fixtures.js";

let app: FastifyInstance;
let world: TestWorld;

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

const DELIVERY = { delivery_date: "2026-09-01", delivery_window: "AM" } as const;

async function createOrder(overrides: Record<string, unknown> = {}) {
  const res = await request(app, {
    method: "POST",
    url: "/v1/orders",
    token: world.orgA.adminToken,
    payload: { client_id: world.orgA.clientId, ...DELIVERY, ...overrides },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Drives a transition through the service, as the driver routes will in Phase 4. */
function driverService(driverId = world.orgA.driverId) {
  return new OrdersService(
    {
      userId: driverId,
      role: "driver",
      organizationId: world.orgA.id,
      requestId: "test",
      ipAddress: null,
      userAgent: null,
    },
    app.log,
  );
}

describe("order creation and client snapshotting (PRD §5.2)", () => {
  it("snapshots the client's details onto the order", async () => {
    const order = await createOrder();
    expect(order.patient_name).toBe("alpha Patient");
    expect(order.address).toBe("100 alpha Street");
    expect(order.phone_number).toBe("+15145550111");
  });

  it("never rewrites history when the client record later changes", async () => {
    const order = await createOrder();

    const updated = await request(app, {
      method: "PATCH",
      url: `/v1/clients/${world.orgA.clientId}`,
      token: world.orgA.adminToken,
      payload: { address: "999 New Address", name: "Renamed Patient" },
    });
    expect(updated.statusCode).toBe(200);

    const after = await request(app, {
      method: "GET",
      url: `/v1/orders/${order.id}`,
      token: world.orgA.adminToken,
    });

    // The whole point of the snapshot: last month's delivery still records
    // where it actually went.
    expect(after.json().address).toBe("100 alpha Street");
    expect(after.json().patient_name).toBe("alpha Patient");
  });

  it("accepts per-order overrides without touching the client", async () => {
    const order = await createOrder({ address: "Apartment 4B, 100 alpha Street" });
    expect(order.address).toBe("Apartment 4B, 100 alpha Street");

    const client = await request(app, {
      method: "GET",
      url: `/v1/clients/${world.orgA.clientId}`,
      token: world.orgA.adminToken,
    });
    expect(client.json().address).toBe("100 alpha Street");
  });

  it("records a creation event so the timeline is complete", async () => {
    const order = await createOrder();
    const detail = await request(app, {
      method: "GET",
      url: `/v1/orders/${order.id}`,
      token: world.orgA.adminToken,
    });

    expect(detail.json().status_events).toHaveLength(1);
    expect(detail.json().status_events[0].status).toBe("in_pharmacy");
  });

  it("refuses to create a delivery for a deactivated client", async () => {
    await request(app, {
      method: "DELETE",
      url: `/v1/clients/${world.orgA.clientId}`,
      token: world.orgA.adminToken,
    });

    const res = await request(app, {
      method: "POST",
      url: "/v1/orders",
      token: world.orgA.adminToken,
      payload: { client_id: world.orgA.clientId, ...DELIVERY },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("CLIENT_INACTIVE");
  });

  it("refuses a client belonging to another organization", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/orders",
      token: world.orgA.adminToken,
      payload: { client_id: world.orgB.clientId, ...DELIVERY },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("the state machine against the database (PRD §5.3)", () => {
  it("walks in_pharmacy -> picked_up -> completed, writing each timestamp", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    const service = driverService();

    const pickedUp = await service.transition(order.id, "pickup");
    expect(pickedUp.status).toBe("picked_up");
    expect(pickedUp.picked_up_at).not.toBeNull();

    const completed = await service.transition(order.id, "complete");
    expect(completed.status).toBe("completed");
    expect(completed.completed_at).not.toBeNull();
  });

  it("walks picked_up -> returned", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    const service = driverService();

    await service.transition(order.id, "pickup");
    const returned = await service.transition(order.id, "return");

    expect(returned.status).toBe("returned");
    expect(returned.returned_at).not.toBeNull();
    // §5.3: nothing was collected, so the order stays unpaid.
    expect(returned.payment_status).toBe("unpaid");
    expect(returned.payment_collected).toBe(false);
  });

  it("writes a status event for every transition, in the same transaction", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    const service = driverService();
    await service.transition(order.id, "pickup");
    await service.transition(order.id, "complete");

    const events = await db("order_status_events")
      .where({ order_id: order.id })
      .orderBy("occurred_at", "asc");

    expect(events.map((e) => e.status)).toEqual([
      "in_pharmacy",
      "picked_up",
      "completed",
    ]);
    // The audit trail must attribute every change (§5.3).
    for (const event of events) {
      expect(event.changed_by_user_id).toBeTruthy();
    }
  });

  it("rejects an invalid transition with 409 and leaves the row untouched", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    const service = driverService();

    await expect(service.transition(order.id, "complete")).rejects.toMatchObject({
      code: "ORDER_INVALID_TRANSITION",
      statusCode: 409,
    });

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.status).toBe("in_pharmacy");
    expect(row.completed_at).toBeNull();
  });

  it("refuses a driver acting on an order assigned to someone else", async () => {
    const [otherDriver] = await db("users")
      .insert({
        organization_id: world.orgA.id,
        role: "driver",
        email: "other@alpha.test",
        password_hash: "x",
        first_name: "Other",
        last_name: "Driver",
      })
      .returning(["id"]);

    const order = await createOrder({ driver_id: world.orgA.driverId });

    await expect(
      driverService(otherDriver.id).transition(order.id, "pickup"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("treats terminal states as immutable", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    const service = driverService();
    await service.transition(order.id, "pickup");
    await service.transition(order.id, "complete");

    for (const transition of ["pickup", "complete", "return"] as const) {
      await expect(service.transition(order.id, transition)).rejects.toMatchObject(
        { code: "ORDER_ALREADY_TERMINAL" },
      );
    }
  });

  it("cancels an order that never left the pharmacy", async () => {
    const order = await createOrder();
    const res = await request(app, {
      method: "POST",
      url: `/v1/orders/${order.id}/cancel`,
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");
    expect(res.json().cancelled_at).not.toBeNull();
  });

  it("cannot cancel an order a driver already picked up", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    await driverService().transition(order.id, "pickup");

    const res = await request(app, {
      method: "POST",
      url: `/v1/orders/${order.id}/cancel`,
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ORDER_INVALID_TRANSITION");
  });

  it("serializes concurrent transitions so only one wins", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    const service = driverService();
    await service.transition(order.id, "pickup");

    // Two taps of "complete" racing — the row lock must make the second fail
    // rather than write a duplicate event.
    const results = await Promise.allSettled([
      service.transition(order.id, "complete"),
      service.transition(order.id, "complete"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const events = await db("order_status_events").where({
      order_id: order.id,
      status: "completed",
    });
    expect(events).toHaveLength(1);
  });
});

describe("order edits and assignment (PRD §5.2)", () => {
  it("allows edits while in_pharmacy", async () => {
    const order = await createOrder();
    const res = await request(app, {
      method: "PATCH",
      url: `/v1/orders/${order.id}`,
      token: world.orgA.adminToken,
      payload: { delivery_window: "PM", amount_due: 25.5 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery_window).toBe("PM");
    expect(res.json().amount_due).toBe(25.5);
  });

  it("refuses edits once a driver holds the package", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    await driverService().transition(order.id, "pickup");

    const res = await request(app, {
      method: "PATCH",
      url: `/v1/orders/${order.id}`,
      token: world.orgA.adminToken,
      payload: { address: "Somewhere else entirely" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ORDER_NOT_EDITABLE");
  });

  it("reassigns a driver and clears the stale route position", async () => {
    const order = await createOrder({ driver_id: world.orgA.driverId });
    await db("orders").where({ id: order.id }).update({ sequence_number: 4 });

    const [second] = await db("users")
      .insert({
        organization_id: world.orgA.id,
        role: "driver",
        email: "second@alpha.test",
        password_hash: "x",
        first_name: "Second",
        last_name: "Driver",
      })
      .returning(["id"]);

    const res = await request(app, {
      method: "POST",
      url: `/v1/orders/${order.id}/assign`,
      token: world.orgA.adminToken,
      payload: { driver_id: second.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().driver_id).toBe(second.id);
    // The previous driver's position means nothing to the new one.
    expect(res.json().sequence_number).toBeNull();
  });

  it("refuses to assign a driver from another organization", async () => {
    const order = await createOrder();
    const res = await request(app, {
      method: "POST",
      url: `/v1/orders/${order.id}/assign`,
      token: world.orgA.adminToken,
      payload: { driver_id: world.orgB.driverId },
    });

    expect(res.statusCode).toBe(404);
  });

  it("refuses to reassign a closed order", async () => {
    const order = await createOrder();
    await request(app, {
      method: "POST",
      url: `/v1/orders/${order.id}/cancel`,
      token: world.orgA.adminToken,
    });

    const res = await request(app, {
      method: "POST",
      url: `/v1/orders/${order.id}/assign`,
      token: world.orgA.adminToken,
      payload: { driver_id: world.orgA.driverId },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ORDER_ALREADY_TERMINAL");
  });
});

describe("order listing", () => {
  it("filters by status, date and driver", async () => {
    await createOrder();
    const assigned = await createOrder({ driver_id: world.orgA.driverId });
    await createOrder({ delivery_date: "2026-12-25" });

    const byDriver = await request(app, {
      method: "GET",
      url: `/v1/orders?driver_id=${world.orgA.driverId}`,
      token: world.orgA.adminToken,
    });
    expect(byDriver.json().data).toHaveLength(1);
    expect(byDriver.json().data[0].id).toBe(assigned.id);

    const byDate = await request(app, {
      method: "GET",
      url: "/v1/orders?date=2026-12-25",
      token: world.orgA.adminToken,
    });
    expect(byDate.json().data).toHaveLength(1);

    const byStatus = await request(app, {
      method: "GET",
      url: "/v1/orders?status=completed",
      token: world.orgA.adminToken,
    });
    expect(byStatus.json().data).toHaveLength(0);
  });

  it("paginates with a stable cursor", async () => {
    for (let i = 0; i < 5; i += 1) await createOrder();

    const first = await request(app, {
      method: "GET",
      url: "/v1/orders?limit=2",
      token: world.orgA.adminToken,
    });
    expect(first.json().data).toHaveLength(2);
    expect(first.json().has_more).toBe(true);

    const second = await request(app, {
      method: "GET",
      url: `/v1/orders?limit=2&cursor=${encodeURIComponent(first.json().next_cursor)}`,
      token: world.orgA.adminToken,
    });

    const firstIds = first.json().data.map((o: { id: string }) => o.id);
    const secondIds = second.json().data.map((o: { id: string }) => o.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it("rejects a malformed cursor rather than ignoring it", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/orders?cursor=not-a-real-cursor",
      token: world.orgA.adminToken,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CURSOR");
  });
});
