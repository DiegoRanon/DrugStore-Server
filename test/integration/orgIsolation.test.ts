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
 * PRD §4.4 calls organization isolation non-negotiable.
 *
 * The suite is table-driven over the route list on purpose: adding an endpoint
 * without scoping it should fail here rather than reach production. When you
 * add a route in a later phase, add it to ROUTES below.
 */

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

async function seedOrgAOrder(): Promise<string> {
  const res = await request(app, {
    method: "POST",
    url: "/v1/orders",
    token: world.orgA.adminToken,
    payload: {
      client_id: world.orgA.clientId,
      delivery_date: "2026-09-01",
      delivery_window: "AM",
    },
  });
  return res.json().id;
}

async function seedOrgAInvite(): Promise<string> {
  const res = await request(app, {
    method: "POST",
    url: "/v1/invites",
    token: world.orgA.adminToken,
    payload: {},
  });
  return res.json().id;
}

describe("cross-organization reads are impossible", () => {
  it("an admin cannot read another organization's order", async () => {
    const orderId = await seedOrgAOrder();

    const res = await request(app, {
      method: "GET",
      url: `/v1/orders/${orderId}`,
      token: world.orgB.adminToken,
    });

    // 404 rather than 403: a 403 would confirm the record exists.
    expect(res.statusCode).toBe(404);
  });

  it("an admin cannot read another organization's client", async () => {
    const res = await request(app, {
      method: "GET",
      url: `/v1/clients/${world.orgA.clientId}`,
      token: world.orgB.adminToken,
    });
    expect(res.statusCode).toBe(404);
  });

  it("list endpoints return only the caller's rows", async () => {
    await seedOrgAOrder();
    await seedOrgAInvite();

    for (const path of ["/v1/orders", "/v1/clients", "/v1/invites", "/v1/drivers"]) {
      const res = await request(app, {
        method: "GET",
        url: path,
        token: world.orgB.adminToken,
      });
      const body = res.json();
      const rows = body.data as { id: string }[];

      expect(res.statusCode, path).toBe(200);
      // Org B has exactly its own single client and single driver.
      const orgBIds = new Set([world.orgB.clientId, world.orgB.driverId]);
      for (const row of rows) {
        expect(orgBIds.has(row.id), `${path} leaked row ${row.id}`).toBe(true);
      }
    }
  });

  it("the driver roster excludes the organization's admin", async () => {
    // The roster is backed by `users`, so the role predicate is what keeps an
    // admin's own account out of a list of drivers.
    const res = await request(app, {
      method: "GET",
      url: "/v1/drivers",
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: string }[]).map((d) => d.id);
    expect(ids).toEqual([world.orgA.driverId]);
    expect(ids).not.toContain(world.orgA.adminId);
  });

  it("a driver search cannot be used to reach across organizations", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/drivers?search=alpha",
      token: world.orgB.adminToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });

  it("a search filter cannot be used to reach across organizations", async () => {
    // A grouped OR is the classic way scoping gets broken: an ungrouped
    // `WHERE org = ? AND (name ILIKE ?) OR phone ILIKE ?` matches everyone.
    const res = await request(app, {
      method: "GET",
      url: "/v1/clients?search=alpha",
      token: world.orgB.adminToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });

  it("filtering by another organization's driver returns nothing", async () => {
    await seedOrgAOrder();
    const res = await request(app, {
      method: "GET",
      url: `/v1/orders?driver_id=${world.orgA.driverId}`,
      token: world.orgB.adminToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });
});

describe("cross-organization writes are impossible", () => {
  it("an admin cannot edit another organization's order", async () => {
    const orderId = await seedOrgAOrder();

    const res = await request(app, {
      method: "PATCH",
      url: `/v1/orders/${orderId}`,
      token: world.orgB.adminToken,
      payload: { delivery_window: "PM" },
    });
    expect(res.statusCode).toBe(404);

    const row = await db("orders").where({ id: orderId }).first();
    expect(row.delivery_window).toBe("AM");
  });

  it("an admin cannot cancel another organization's order", async () => {
    const orderId = await seedOrgAOrder();

    const res = await request(app, {
      method: "POST",
      url: `/v1/orders/${orderId}/cancel`,
      token: world.orgB.adminToken,
    });
    expect(res.statusCode).toBe(404);

    const row = await db("orders").where({ id: orderId }).first();
    expect(row.status).toBe("scheduled");
  });

  it("an admin cannot deactivate another organization's client", async () => {
    const res = await request(app, {
      method: "DELETE",
      url: `/v1/clients/${world.orgA.clientId}`,
      token: world.orgB.adminToken,
    });
    expect(res.statusCode).toBe(404);

    const row = await db("clients").where({ id: world.orgA.clientId }).first();
    expect(row.is_active).toBe(true);
  });

  it("an admin cannot delete another organization's invite code", async () => {
    const inviteId = await seedOrgAInvite();

    const res = await request(app, {
      method: "DELETE",
      url: `/v1/invites/${inviteId}`,
      token: world.orgB.adminToken,
    });
    expect(res.statusCode).toBe(404);

    const row = await db("invite_codes").where({ id: inviteId }).first();
    expect(row.is_active).toBe(true);
  });
});

describe("every authenticated route is scoped", () => {
  /**
   * Add every new authenticated route here as it ships. A route that reads or
   * writes an org-owned row must answer 404 for a caller from another org.
   */
  const ROUTES: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: (ids: {
      orderId: string;
      clientId: string;
      inviteId: string;
      driverId: string;
    }) => string;
    payload?: unknown;
  }[] = [
    { method: "GET", url: ({ orderId }) => `/v1/orders/${orderId}` },
    {
      method: "PATCH",
      url: ({ orderId }) => `/v1/orders/${orderId}`,
      payload: { delivery_window: "PM" },
    },
    { method: "POST", url: ({ orderId }) => `/v1/orders/${orderId}/ready` },
    {
      method: "POST",
      url: ({ orderId }) => `/v1/orders/${orderId}/assign`,
      payload: { driver_id: null },
    },
    {
      method: "POST",
      url: ({ orderId }) => `/v1/orders/${orderId}/priority`,
      payload: { is_priority: true },
    },
    { method: "POST", url: ({ orderId }) => `/v1/orders/${orderId}/cancel` },
    { method: "GET", url: ({ clientId }) => `/v1/clients/${clientId}` },
    {
      method: "PATCH",
      url: ({ clientId }) => `/v1/clients/${clientId}`,
      payload: { name: "Hijacked" },
    },
    { method: "DELETE", url: ({ clientId }) => `/v1/clients/${clientId}` },
    { method: "DELETE", url: ({ inviteId }) => `/v1/invites/${inviteId}` },
    { method: "GET", url: ({ driverId }) => `/v1/drivers/${driverId}` },
    {
      method: "PATCH",
      url: ({ driverId }) => `/v1/drivers/${driverId}`,
      payload: { is_active: false },
    },
  ];

  /**
   * Driver routes are scoped twice over: by organization, and by
   * `orders.driver_id = self`. A foreign driver must see a 404, never a 403.
   */
  const DRIVER_ROUTES: {
    method: "POST";
    url: (ids: { orderId: string }) => string;
    payload?: unknown;
  }[] = [
    { method: "POST", url: ({ orderId }) => `/v1/driver/orders/${orderId}/pickup` },
    { method: "POST", url: ({ orderId }) => `/v1/driver/orders/${orderId}/complete` },
    {
      method: "POST",
      url: ({ orderId }) => `/v1/driver/orders/${orderId}/return`,
      payload: { reason: "customer_absent" },
    },
    {
      method: "POST",
      url: ({ orderId }) => `/v1/driver/orders/${orderId}/handover`,
    },
    {
      method: "POST",
      url: ({ orderId }) => `/v1/driver/orders/${orderId}/priority`,
      payload: { is_priority: true },
    },
    {
      method: "POST",
      url: ({ orderId }) => `/v1/driver/orders/${orderId}/payment`,
      payload: { payment_method: "cash", amount_collected: 10 },
    },
    {
      method: "POST",
      url: ({ orderId }) => `/v1/driver/orders/${orderId}/cooler-check`,
      payload: { confirmed: true },
    },
  ];

  it("refuses every org-owned route for a caller from another organization", async () => {
    const ids = {
      orderId: await seedOrgAOrder(),
      clientId: world.orgA.clientId,
      inviteId: await seedOrgAInvite(),
      driverId: world.orgA.driverId,
    };

    for (const route of ROUTES) {
      const url = route.url(ids);
      const res = await request(app, {
        method: route.method,
        url,
        token: world.orgB.adminToken,
        payload: route.payload,
      });

      expect(
        res.statusCode,
        `${route.method} ${url} answered ${res.statusCode} for a foreign org`,
      ).toBe(404);
    }
  });

  it("refuses every one of those routes without a token at all", async () => {
    const ids = {
      orderId: await seedOrgAOrder(),
      clientId: world.orgA.clientId,
      inviteId: await seedOrgAInvite(),
      driverId: world.orgA.driverId,
    };

    for (const route of ROUTES) {
      const url = route.url(ids);
      const res = await request(app, {
        method: route.method,
        url,
        payload: route.payload,
      });

      expect(res.statusCode, `${route.method} ${url}`).toBe(401);
    }
  });

  it("hides an order from a driver in another organization", async () => {
    const orderId = await seedOrgAOrder();
    await db("orders")
      .where({ id: orderId })
      .update({
        driver_id: world.orgA.driverId,
        status: "picked_up",
        // ready_at as well: chk_status_stage_timestamp requires every status
        // past the calendar to record when staff declared it prepared.
        ready_at: new Date(),
        picked_up_at: new Date(),
      });

    for (const route of DRIVER_ROUTES) {
      const url = route.url({ orderId });
      const res = await request(app, {
        method: route.method,
        url,
        token: world.orgB.driverToken,
        payload: route.payload,
      });

      expect(res.statusCode, `${route.method} ${url}`).toBe(404);
    }
  });

  it("hides an order from a different driver in the SAME organization", async () => {
    // §4.4: drivers are restricted to rows where orders.driver_id = self,
    // which org scoping alone does not give you.
    const orderId = await seedOrgAOrder();
    await db("orders")
      .where({ id: orderId })
      .update({
        driver_id: world.orgA.driverId,
        status: "picked_up",
        // ready_at as well: chk_status_stage_timestamp requires every status
        // past the calendar to record when staff declared it prepared.
        ready_at: new Date(),
        picked_up_at: new Date(),
      });

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

    const colleagueToken = app.jwt.sign({
      sub: colleague.id,
      role: "driver",
      org_id: world.orgA.id,
    });

    for (const route of DRIVER_ROUTES) {
      const url = route.url({ orderId });
      const res = await request(app, {
        method: route.method,
        url,
        token: colleagueToken,
        payload: route.payload,
      });

      expect(res.statusCode, `${route.method} ${url}`).toBe(404);
    }
  });

  it("refuses a token signed for an organization that no longer exists", async () => {
    const orphanToken = app.jwt.sign({
      sub: world.orgA.adminId,
      role: "admin",
      org_id: "00000000-0000-0000-0000-000000000000",
    });

    const res = await request(app, {
      method: "GET",
      url: `/v1/orders/${await seedOrgAOrder()}`,
      token: orphanToken,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("role separation", () => {
  it("a driver cannot reach admin surfaces", async () => {
    for (const path of ["/v1/clients", "/v1/orders", "/v1/invites", "/v1/drivers"]) {
      const res = await request(app, {
        method: "GET",
        url: path,
        token: world.orgA.driverToken,
      });
      expect(res.statusCode, path).toBe(403);
    }
  });

  it("a user token cannot reach the internal provisioning API", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/internal/organizations",
      token: world.orgA.adminToken,
    });
    expect(res.statusCode).toBe(401);
  });
});
