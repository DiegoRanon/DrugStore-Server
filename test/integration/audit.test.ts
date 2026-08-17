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
 * PRD §8.4 — Law 25 accountability.
 *
 * `order_status_events` records who *changed* an order. This suite covers the
 * other half: who *read* personal information. Every admin response carrying a
 * patient name, address, or phone number must leave a row behind.
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

interface AuditRow {
  actor_user_id: string;
  actor_role: string;
  organization_id: string;
  action: string;
  resource_type: string;
  resource_ids: string[] | null;
  record_count: number | null;
  request_id: string | null;
  user_agent: string | null;
}

async function auditRows(action?: string): Promise<AuditRow[]> {
  const query = db<AuditRow>("access_audit_log").orderBy("occurred_at", "asc");
  if (action) query.where({ action });
  return query;
}

async function seedOrder(): Promise<string> {
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

describe("admin PII reads are recorded", () => {
  it("records an order detail read against the specific order", async () => {
    const orderId = await seedOrder();

    await request(app, {
      method: "GET",
      url: `/v1/orders/${orderId}`,
      token: world.orgA.adminToken,
    });

    const rows = await auditRows("order.detail.read");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resource_type).toBe("order");
    expect(rows[0]!.resource_ids).toEqual([orderId]);
    expect(rows[0]!.actor_user_id).toBe(world.orgA.adminId);
    expect(rows[0]!.actor_role).toBe("admin");
    expect(rows[0]!.organization_id).toBe(world.orgA.id);
    expect(rows[0]!.request_id).toBeTruthy();
  });

  it("records an order list read with the row count, not every id", async () => {
    await seedOrder();
    await seedOrder();

    await request(app, {
      method: "GET",
      url: "/v1/orders",
      token: world.orgA.adminToken,
    });

    const rows = await auditRows("order.list.read");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.record_count).toBe(2);
    // Bounded reads carry ids; a 200-row page would bloat the trail.
    expect(rows[0]!.resource_ids).toBeNull();
  });

  it("records client list and detail reads", async () => {
    await request(app, {
      method: "GET",
      url: "/v1/clients",
      token: world.orgA.adminToken,
    });
    await request(app, {
      method: "GET",
      url: `/v1/clients/${world.orgA.clientId}`,
      token: world.orgA.adminToken,
    });

    const list = await auditRows("client.list.read");
    const detail = await auditRows("client.detail.read");

    expect(list).toHaveLength(1);
    expect(list[0]!.record_count).toBe(1);
    expect(detail).toHaveLength(1);
    expect(detail[0]!.resource_ids).toEqual([world.orgA.clientId]);
  });

  it("attributes each read to the organization that made it", async () => {
    await request(app, {
      method: "GET",
      url: "/v1/clients",
      token: world.orgA.adminToken,
    });
    await request(app, {
      method: "GET",
      url: "/v1/clients",
      token: world.orgB.adminToken,
    });

    const rows = await auditRows("client.list.read");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.organization_id))).toEqual(
      new Set([world.orgA.id, world.orgB.id]),
    );
  });

  it("records nothing for a read that returned nothing", async () => {
    // A 404 never reached the PII, so there is nothing to account for.
    await request(app, {
      method: "GET",
      url: "/v1/orders/00000000-0000-0000-0000-000000000000",
      token: world.orgA.adminToken,
    });

    expect(await auditRows("order.detail.read")).toHaveLength(0);
  });

  it("does not record driver queue reads", async () => {
    // §8.3 already limits what a driver sees to the active delivery; auditing
    // a 15s poll would bury the admin trail in operational noise.
    await request(app, {
      method: "GET",
      url: "/v1/driver/queue",
      token: world.orgA.driverToken,
    });

    expect(await auditRows()).toHaveLength(0);
  });

  it("truncates an over-long user agent to fit the column", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/clients",
      headers: {
        authorization: `Bearer ${world.orgA.adminToken}`,
        "user-agent": "U".repeat(400),
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = await auditRows("client.list.read");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_agent!.length).toBe(255);
  });
});

describe("the trail cannot be rewritten", () => {
  it("rejects UPDATE and DELETE", async () => {
    await request(app, {
      method: "GET",
      url: "/v1/clients",
      token: world.orgA.adminToken,
    });
    expect(await auditRows()).not.toHaveLength(0);

    await expect(
      db("access_audit_log").update({ action: "tampered" }),
    ).rejects.toThrow(/append-only/);

    await expect(db("access_audit_log").del()).rejects.toThrow(/append-only/);

    const rows = await auditRows();
    expect(rows.every((r) => r.action !== "tampered")).toBe(true);
  });
});

describe("an audit failure does not break the request", () => {
  it("still serves the read when the audit insert fails", async () => {
    // Fail-open by design (see src/core/audit.ts): an audit-table problem must
    // not turn a pharmacist's order lookup into a 500.
    await db.raw("ALTER TABLE access_audit_log RENAME TO access_audit_log_tmp");
    try {
      const res = await request(app, {
        method: "GET",
        url: "/v1/clients",
        token: world.orgA.adminToken,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
    } finally {
      await db.raw(
        "ALTER TABLE access_audit_log_tmp RENAME TO access_audit_log",
      );
    }
  });
});
