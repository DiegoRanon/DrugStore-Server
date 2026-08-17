import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis } from "../../src/db/redis.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import {
  createTestApp,
  createWorld,
  request,
  TEST_PASSWORD,
  type TestWorld,
} from "../helpers/fixtures.js";

/**
 * The driver roster (MVP §6). The dashboard needs this to resolve
 * `orders.driver_id` to a name and to populate the assign dropdown, so the
 * invariants that matter are: only this org's rows, only drivers (never the
 * admin), and deactivation actually ends the driver's session.
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

async function addDriver(
  orgId: string,
  lastName: string,
  overrides: { is_active?: boolean } = {},
): Promise<string> {
  const [row] = await db("users")
    .insert({
      organization_id: orgId,
      role: "driver",
      email: `${lastName.toLowerCase()}@roster.test`,
      password_hash: await hashPassword(TEST_PASSWORD),
      first_name: "Test",
      last_name: lastName,
      is_active: overrides.is_active ?? true,
    })
    .returning(["id"]);
  return row.id;
}

describe("GET /v1/drivers", () => {
  it("returns the organization's drivers sorted by last name", async () => {
    await addDriver(world.orgA.id, "Zenon");
    await addDriver(world.orgA.id, "Abbott");

    const res = await request(app, {
      method: "GET",
      url: "/v1/drivers",
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(200);
    const names = (res.json().data as { last_name: string }[]).map(
      (d) => d.last_name,
    );
    // "alpha" is the seeded driver's last name from the fixture.
    expect(names).toEqual(["Abbott", "Zenon", "alpha"]);
  });

  it("never includes an admin account", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/drivers",
      token: world.orgA.adminToken,
    });

    const ids = (res.json().data as { id: string }[]).map((d) => d.id);
    expect(ids).not.toContain(world.orgA.adminId);
  });

  it("does not expose a password hash", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/drivers",
      token: world.orgA.adminToken,
    });

    expect(JSON.stringify(res.json())).not.toContain("password");
  });

  it("filters by is_active", async () => {
    await addDriver(world.orgA.id, "Retired", { is_active: false });

    const active = await request(app, {
      method: "GET",
      url: "/v1/drivers?is_active=true",
      token: world.orgA.adminToken,
    });
    const inactive = await request(app, {
      method: "GET",
      url: "/v1/drivers?is_active=false",
      token: world.orgA.adminToken,
    });

    expect((active.json().data as unknown[]).length).toBe(1);
    const inactiveRows = inactive.json().data as { last_name: string }[];
    expect(inactiveRows).toHaveLength(1);
    expect(inactiveRows[0]!.last_name).toBe("Retired");
  });

  it("searches across first name, last name, and email", async () => {
    await addDriver(world.orgA.id, "Tremblay");

    for (const term of ["Tremblay", "tremblay@roster", "Test"]) {
      const res = await request(app, {
        method: "GET",
        url: `/v1/drivers?search=${encodeURIComponent(term)}`,
        token: world.orgA.adminToken,
      });
      const rows = res.json().data as { last_name: string }[];
      expect(
        rows.some((d) => d.last_name === "Tremblay"),
        `search=${term}`,
      ).toBe(true);
    }
  });

  it("paginates with a stable cursor", async () => {
    for (const name of ["Brown", "Clark", "Davis"]) {
      await addDriver(world.orgA.id, name);
    }

    const first = await request(app, {
      method: "GET",
      url: "/v1/drivers?limit=2",
      token: world.orgA.adminToken,
    });
    const firstBody = first.json();

    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.has_more).toBe(true);
    expect(firstBody.next_cursor).toBeTruthy();

    const second = await request(app, {
      method: "GET",
      url: `/v1/drivers?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
      token: world.orgA.adminToken,
    });
    const secondBody = second.json();

    const firstIds = (firstBody.data as { id: string }[]).map((d) => d.id);
    const secondIds = (secondBody.data as { id: string }[]).map((d) => d.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it("rejects a malformed cursor", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/drivers?cursor=not-a-cursor",
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CURSOR");
  });
});

describe("GET /v1/drivers/:id", () => {
  it("returns a driver in the caller's organization", async () => {
    const res = await request(app, {
      method: "GET",
      url: `/v1/drivers/${world.orgA.driverId}`,
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(world.orgA.driverId);
  });

  it("404s for the organization's own admin id", async () => {
    // Scoped by role as well as org — an admin id is not a driver id.
    const res = await request(app, {
      method: "GET",
      url: `/v1/drivers/${world.orgA.adminId}`,
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /v1/drivers/:id", () => {
  it("deactivates a driver and revokes their refresh tokens", async () => {
    // Log in for real so there is a live refresh token to revoke.
    const login = await request(app, {
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "driver@alpha.test", password: TEST_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const refreshToken = login.json().refresh_token;

    const res = await request(app, {
      method: "PATCH",
      url: `/v1/drivers/${world.orgA.driverId}`,
      token: world.orgA.adminToken,
      payload: { is_active: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().is_active).toBe(false);

    const row = await db("users").where({ id: world.orgA.driverId }).first();
    expect(row.is_active).toBe(false);

    // The session must be dead immediately. Without this, clearing is_active
    // only blocks new logins while the existing refresh token keeps working
    // for up to REFRESH_TOKEN_TTL_DAYS.
    const refresh = await request(app, {
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token: refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    const tokens = await db("refresh_tokens").where({
      user_id: world.orgA.driverId,
    });
    expect(tokens.every((t) => t.revoked_at !== null)).toBe(true);
    expect(tokens.every((t) => t.revoked_reason === "user_deactivated")).toBe(
      true,
    );
  });

  it("reports orders still assigned so they can be reassigned", async () => {
    const order = await request(app, {
      method: "POST",
      url: "/v1/orders",
      token: world.orgA.adminToken,
      payload: {
        client_id: world.orgA.clientId,
        driver_id: world.orgA.driverId,
        delivery_date: "2026-09-01",
        delivery_window: "AM",
      },
    });
    expect(order.statusCode).toBe(201);

    const res = await request(app, {
      method: "PATCH",
      url: `/v1/drivers/${world.orgA.driverId}`,
      token: world.orgA.adminToken,
      payload: { is_active: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().active_order_count).toBe(1);
  });

  it("reactivates a driver", async () => {
    await request(app, {
      method: "PATCH",
      url: `/v1/drivers/${world.orgA.driverId}`,
      token: world.orgA.adminToken,
      payload: { is_active: false },
    });

    const res = await request(app, {
      method: "PATCH",
      url: `/v1/drivers/${world.orgA.driverId}`,
      token: world.orgA.adminToken,
      payload: { is_active: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().is_active).toBe(true);
  });

  it("is idempotent when the status is unchanged", async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app, {
        method: "PATCH",
        url: `/v1/drivers/${world.orgA.driverId}`,
        token: world.orgA.adminToken,
        payload: { is_active: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().is_active).toBe(false);
    }
  });

  it("cannot be used to edit anything but employment status", async () => {
    const res = await request(app, {
      method: "PATCH",
      url: `/v1/drivers/${world.orgA.driverId}`,
      token: world.orgA.adminToken,
      payload: { is_active: true, email: "hijacked@evil.test" },
    });

    expect(res.statusCode).toBe(200);
    const row = await db("users").where({ id: world.orgA.driverId }).first();
    expect(row.email).toBe("driver@alpha.test");
  });

  it("cannot deactivate the organization's admin through the driver route", async () => {
    const res = await request(app, {
      method: "PATCH",
      url: `/v1/drivers/${world.orgA.adminId}`,
      token: world.orgA.adminToken,
      payload: { is_active: false },
    });

    expect(res.statusCode).toBe(404);
    const row = await db("users").where({ id: world.orgA.adminId }).first();
    expect(row.is_active).toBe(true);
  });
});

describe("a deactivated driver cannot use the API", () => {
  it("refuses login", async () => {
    await request(app, {
      method: "PATCH",
      url: `/v1/drivers/${world.orgA.driverId}`,
      token: world.orgA.adminToken,
      payload: { is_active: false },
    });

    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "driver@alpha.test", password: TEST_PASSWORD },
    });

    expect(res.statusCode).toBe(403);
  });
});
