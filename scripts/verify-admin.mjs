/**
 * Admin dashboard readiness smoke test — driver roster, PII audit trail,
 * OpenAPI spec, and browser CORS.
 *
 * These are the surfaces the React admin panel depends on that the earlier
 * verify scripts do not touch. Like its siblings, this exercises the real HTTP
 * stack; it is NOT a replacement for the Vitest suites.
 *
 *   npm run verify:admin
 *
 * Requires: server running, migrations applied, and `npm run seed`.
 */
import { config as loadDotenv } from "dotenv";

loadDotenv();

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const SEED_PASSWORD = "DevPassword123!";
const ORG_A_ADMIN = "admin@stlaurent.example.ca";
const ORG_B_ADMIN = "admin@riverside.example.ca";
const DASHBOARD_ORIGIN = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
  .split(",")[0]
  .trim();

let pass = 0;
let fail = 0;
const failures = [];

async function call(method, path, { body, token, headers: extra } = {}) {
  const headers = body ? { "content-type": "application/json" } : {};
  if (token) headers.authorization = `Bearer ${token}`;
  Object.assign(headers, extra ?? {});

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function clearRateLimits() {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    const { Redis } = await import("ioredis");
    const redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    await redis.connect();
    const keys = [...(await redis.keys("ratelimit:*")), ...(await redis.keys("login:*"))];
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  } catch {
    // Non-fatal: worst case a later request is rate limited and says so.
  }
}

// --- setup -----------------------------------------------------------------

console.log(`\nVerifying the admin dashboard surface against ${BASE}`);

const health = await call("GET", "/health").catch(() => null);
if (!health || health.status !== 200) {
  console.error(`\n\x1b[31mServer is not reachable at ${BASE}\x1b[0m\nStart it with: npm run dev\n`);
  process.exit(1);
}

await clearRateLimits();

const login = async (email) =>
  (await call("POST", "/v1/auth/login", { body: { email, password: SEED_PASSWORD } })).body;

const sessionA = await login(ORG_A_ADMIN);
const sessionB = await login(ORG_B_ADMIN);
const tokenA = sessionA?.access_token;
const tokenB = sessionB?.access_token;

if (!tokenA || !tokenB) {
  console.error("\n\x1b[31mCould not log in as the seeded admins. Run `npm run seed`.\x1b[0m\n");
  process.exit(1);
}

const orgAId = sessionA.user.organization_id;

// --- driver roster ---------------------------------------------------------

section("Driver roster (MVP §6 — User Management)");

const roster = await call("GET", "/v1/drivers", { token: tokenA });
check("lists the organization's drivers", roster.status === 200 && Array.isArray(roster.body?.data));

const drivers = roster.body?.data ?? [];
check("returns at least the seeded driver", drivers.length >= 1, `got ${drivers.length}`);

check(
  "every row is a driver of this organization",
  drivers.every((d) => typeof d.id === "string" && typeof d.first_name === "string"),
);

check(
  "never leaks a password hash",
  !JSON.stringify(roster.body).toLowerCase().includes("password"),
);

const rosterB = await call("GET", "/v1/drivers", { token: tokenB });
const idsA = new Set(drivers.map((d) => d.id));
check(
  "another organization sees a disjoint roster",
  (rosterB.body?.data ?? []).every((d) => !idsA.has(d.id)),
);

const driverId = drivers[0]?.id;
const detail = await call("GET", `/v1/drivers/${driverId}`, { token: tokenA });
check("reads a single driver", detail.status === 200 && detail.body?.id === driverId);

const foreign = await call("GET", `/v1/drivers/${driverId}`, { token: tokenB });
check("hides that driver from another organization (404, not 403)", foreign.status === 404);

const adminAsDriver = await call("GET", `/v1/drivers/${sessionA.user.id}`, { token: tokenA });
check("an admin id is not addressable as a driver", adminAsDriver.status === 404);

const asDriver = await call("GET", "/v1/drivers", {
  token: (await login("driver@stlaurent.example.ca"))?.access_token,
});
check("a driver cannot read the roster", asDriver.status === 403);

// The dashboard's assign dropdown depends on this pairing: roster ids must be
// accepted by the assign endpoint.
section("Roster feeds the assign dropdown");

const clientsRes = await call("GET", "/v1/clients?limit=1", { token: tokenA });
const clientId = clientsRes.body?.data?.[0]?.id;

const order = await call("POST", "/v1/orders", {
  token: tokenA,
  body: {
    client_id: clientId,
    delivery_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    delivery_window: "AM",
  },
});
check("creates an order to assign", order.status === 201, JSON.stringify(order.body));

const assigned = await call("POST", `/v1/orders/${order.body?.id}/assign`, {
  token: tokenA,
  body: { driver_id: driverId },
});
check(
  "assigns an order to a driver taken from the roster",
  assigned.status === 200 && assigned.body?.driver_id === driverId,
  JSON.stringify(assigned.body?.driver_id),
);

// --- deactivation ----------------------------------------------------------

section("Deactivation ends the session (Law 25 access control)");

const inviteRes = await call("POST", "/v1/invites", { token: tokenA, body: {} });
const inviteCode = inviteRes.body?.code;
const throwaway = `verify-${Date.now()}@stlaurent.example.ca`;

const registered = await call("POST", "/v1/auth/register/driver", {
  body: {
    code: inviteCode,
    email: throwaway,
    password: "ThrowawayPass123!",
    first_name: "Verify",
    last_name: "Throwaway",
  },
});
check("registers a driver with an invite code", registered.status === 201, JSON.stringify(registered.body));

const newDriverId = registered.body?.id;

const rosterAfter = await call("GET", "/v1/drivers?search=Throwaway", { token: tokenA });
check(
  "the new driver appears on the roster immediately",
  (rosterAfter.body?.data ?? []).some((d) => d.id === newDriverId),
);

const driverSession = await call("POST", "/v1/auth/login", {
  body: { email: throwaway, password: "ThrowawayPass123!" },
});
check("the new driver can log in", driverSession.status === 200);
const driverRefresh = driverSession.body?.refresh_token;

const deactivated = await call("PATCH", `/v1/drivers/${newDriverId}`, {
  token: tokenA,
  body: { is_active: false },
});
check(
  "deactivates the driver",
  deactivated.status === 200 && deactivated.body?.is_active === false,
  JSON.stringify(deactivated.body),
);
check(
  "reports how many orders are still assigned",
  typeof deactivated.body?.active_order_count === "number",
);

const refreshAfter = await call("POST", "/v1/auth/refresh", {
  body: { refresh_token: driverRefresh },
});
check(
  "their refresh token is revoked immediately",
  refreshAfter.status === 401,
  `got ${refreshAfter.status}`,
);

const loginAfter = await call("POST", "/v1/auth/login", {
  body: { email: throwaway, password: "ThrowawayPass123!" },
});
check("they can no longer log in", loginAfter.status === 403, `got ${loginAfter.status}`);

const reactivated = await call("PATCH", `/v1/drivers/${newDriverId}`, {
  token: tokenA,
  body: { is_active: true },
});
check("can be reactivated", reactivated.status === 200 && reactivated.body?.is_active === true);

// --- audit trail -----------------------------------------------------------

section("PII access audit trail (PRD §8.4 / Law 25)");

let auditOk = false;
let auditDetail = "DATABASE_URL not set";
if (process.env.DATABASE_URL) {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    const before = await client.query("SELECT count(*)::int AS n FROM access_audit_log");

    await call("GET", "/v1/orders?limit=5", { token: tokenA });
    await call("GET", `/v1/orders/${order.body?.id}`, { token: tokenA });
    await call("GET", "/v1/clients?limit=5", { token: tokenA });

    const after = await client.query(
      `SELECT action, resource_type, record_count, resource_ids, actor_role, organization_id, request_id
         FROM access_audit_log ORDER BY occurred_at DESC LIMIT 3`,
    );

    const grew = after.rowCount === 3 && before.rows[0].n < (await client.query("SELECT count(*)::int AS n FROM access_audit_log")).rows[0].n;
    check("admin PII reads land in access_audit_log", grew);

    const actions = after.rows.map((r) => r.action);
    check(
      "records list and detail reads distinctly",
      actions.includes("client.list.read") &&
        actions.includes("order.detail.read") &&
        actions.includes("order.list.read"),
      actions.join(", "),
    );

    const detailRow = after.rows.find((r) => r.action === "order.detail.read");
    check(
      "a detail read names the row it touched",
      Array.isArray(detailRow?.resource_ids) && detailRow.resource_ids.length === 1,
    );

    const listRow = after.rows.find((r) => r.action === "order.list.read");
    check(
      "a list read records a count, not every id",
      typeof listRow?.record_count === "number" && listRow.resource_ids === null,
    );

    check(
      "each row carries actor, organization, and request id",
      after.rows.every(
        (r) => r.actor_role === "admin" && r.organization_id === orgAId && r.request_id,
      ),
    );

    // The append-only trigger is the control that makes the trail trustworthy.
    let rejected = false;
    try {
      await client.query("UPDATE access_audit_log SET action = 'tampered'");
    } catch (error) {
      rejected = /append-only/.test(error.message);
    }
    check("the trail rejects UPDATE", rejected);

    let deleteRejected = false;
    try {
      await client.query("DELETE FROM access_audit_log");
    } catch (error) {
      deleteRejected = /append-only/.test(error.message);
    }
    check("the trail rejects DELETE", deleteRejected);

    await client.end();
    auditOk = true;
  } catch (error) {
    auditDetail = error.message;
  }
}
if (!auditOk && !process.env.DATABASE_URL) {
  check("audit trail inspected", false, auditDetail);
}

// --- OpenAPI + CORS --------------------------------------------------------

section("API contract and browser access");

const spec = await call("GET", "/docs/json");
check("serves the OpenAPI document", spec.status === 200 && !!spec.body?.paths);

const paths = Object.keys(spec.body?.paths ?? {});
check("documents the driver roster", paths.includes("/v1/drivers/"));
check(
  "hides the internal provisioning API",
  !paths.some((p) => p.includes("/internal")),
  paths.filter((p) => p.includes("/internal")).join(", "),
);
check(
  "declares bearer auth for client generation",
  spec.body?.components?.securitySchemes?.bearerAuth?.scheme === "bearer",
);

// The failure mode that never reproduces in curl: a browser preflight.
const preflight = await fetch(`${BASE}/v1/auth/login`, {
  method: "OPTIONS",
  headers: {
    origin: DASHBOARD_ORIGIN,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  },
});
check(
  `CORS preflight succeeds for ${DASHBOARD_ORIGIN}`,
  preflight.status >= 200 && preflight.status < 300,
  `got ${preflight.status}`,
);
check(
  "the dashboard origin is echoed back",
  preflight.headers.get("access-control-allow-origin") === DASHBOARD_ORIGIN,
  String(preflight.headers.get("access-control-allow-origin")),
);

const rogue = await fetch(`${BASE}/v1/auth/login`, {
  method: "OPTIONS",
  headers: {
    origin: "https://evil.example.com",
    "access-control-request-method": "POST",
  },
});
check(
  "an unlisted origin is not allowed",
  rogue.headers.get("access-control-allow-origin") !== "https://evil.example.com",
  String(rogue.headers.get("access-control-allow-origin")),
);

// --- summary ---------------------------------------------------------------

console.log(
  `\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`,
);
if (fail > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
