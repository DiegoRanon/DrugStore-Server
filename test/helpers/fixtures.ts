import type { FastifyInstance } from "fastify";

import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/knex.js";
import { hashPassword } from "../../src/modules/auth/password.js";

/**
 * Two fully-populated organizations.
 *
 * Every isolation test needs a second tenant holding real data — against a
 * single-org database a leak looks identical to a correct empty result.
 */

export interface TestOrg {
  id: string;
  name: string;
  adminId: string;
  adminToken: string;
  driverId: string;
  driverToken: string;
  clientId: string;
}

export interface TestWorld {
  app: FastifyInstance;
  orgA: TestOrg;
  orgB: TestOrg;
}

const PASSWORD = "TestPassword123!";

/** Order matters — children before parents. */
const TABLES = [
  "order_status_events",
  "invoice_line_items",
  "invoices",
  "notifications",
  "driver_locations",
  "idempotency_keys",
  "orders",
  "clients",
  "refresh_tokens",
  "invite_codes",
  "users",
  "organizations",
];

export async function truncateAll(): Promise<void> {
  await db.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  // access_audit_log has an append-only trigger that rejects DELETE, so it is
  // truncated separately (TRUNCATE bypasses row triggers).
  await db.raw("TRUNCATE TABLE access_audit_log RESTART IDENTITY");
}

async function seedOrg(
  app: FastifyInstance,
  label: string,
  passwordHash: string,
): Promise<TestOrg> {
  const [org] = await db("organizations")
    .insert({
      name: `${label} Pharmacy`,
      phone: "+15145550100",
      email: `contact@${label}.test`,
      delivery_rate: 7.5,
    })
    .returning(["id", "name"]);

  const [admin] = await db("users")
    .insert({
      organization_id: org.id,
      role: "admin",
      email: `admin@${label}.test`,
      password_hash: passwordHash,
      first_name: "Admin",
      last_name: label,
    })
    .returning(["id"]);

  const [driver] = await db("users")
    .insert({
      organization_id: org.id,
      role: "driver",
      email: `driver@${label}.test`,
      password_hash: passwordHash,
      first_name: "Driver",
      last_name: label,
    })
    .returning(["id"]);

  const [client] = await db("clients")
    .insert({
      organization_id: org.id,
      name: `${label} Patient`,
      address: `100 ${label} Street`,
      phone_number: "+15145550111",
    })
    .returning(["id"]);

  // Tokens are signed through the app so the tests exercise the same claim
  // shape the auth plugin verifies.
  const sign = (userId: string, role: "admin" | "driver"): string =>
    app.jwt.sign({ sub: userId, role, org_id: org.id });

  return {
    id: org.id,
    name: org.name,
    adminId: admin.id,
    adminToken: sign(admin.id, "admin"),
    driverId: driver.id,
    driverToken: sign(driver.id, "driver"),
    clientId: client.id,
  };
}

export async function createWorld(app: FastifyInstance): Promise<TestWorld> {
  await truncateAll();
  const passwordHash = await hashPassword(PASSWORD);
  return {
    app,
    orgA: await seedOrg(app, "alpha", passwordHash),
    orgB: await seedOrg(app, "beta", passwordHash),
  };
}

export async function createTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/** Convenience wrapper around app.inject with bearer auth. */
export function request(
  app: FastifyInstance,
  options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token?: string;
    payload?: unknown;
  },
) {
  return app.inject({
    method: options.method,
    url: options.url,
    headers: options.token
      ? { authorization: `Bearer ${options.token}` }
      : undefined,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

export const TEST_PASSWORD = PASSWORD;
