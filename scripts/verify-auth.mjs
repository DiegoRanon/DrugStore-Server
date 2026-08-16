/**
 * Phase 2 authentication smoke test.
 *
 * Exercises every auth path against a running server: internal provisioning,
 * login, /me, invite lifecycle, driver registration, role enforcement, refresh
 * rotation with reuse detection, organization isolation, and the API
 * conventions from PRD §3.
 *
 * This is a black-box check you can run by hand — it is NOT a replacement for
 * the Vitest suites, which still need writing.
 *
 *   npm run verify:auth
 *   BASE_URL=https://staging.example.ca npm run verify:auth -- --no-reset
 *
 * Flags:
 *   --no-reset   Skip clearing Redis throttle counters (required against any
 *                environment where you should not be flushing keys).
 *
 * Requires: the server running, migrations applied, and `npm run seed`.
 */
import { config as loadDotenv } from "dotenv";

loadDotenv();

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const INTERNAL = process.env.INTERNAL_API_TOKEN ?? "";
const SEED_PASSWORD = "DevPassword123!";
const RESET = !process.argv.includes("--no-reset");

const ORG_A_ADMIN = "admin@stlaurent.example.ca";
const ORG_B_ADMIN = "admin@riverside.example.ca";

let pass = 0;
let fail = 0;
let throttled = 0;
const failures = [];

// --- helpers ---------------------------------------------------------------

async function call(method, path, { body, token, internal } = {}) {
  // Only declare a JSON content-type when there is actually a body — Fastify
  // rejects an empty body that claims to be JSON, which would mask the real
  // response on bodyless verbs like DELETE.
  const headers = body ? { "content-type": "application/json" } : {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (internal) headers.authorization = `Bearer ${INTERNAL}`;

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

  if (res.status === 429 && parsed?.error?.code === "RATE_LIMITED") throttled += 1;
  return { status: res.status, body: parsed };
}

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  [32mPASS[0m  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  [31mFAIL[0m  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

/**
 * Rate limits are per-IP and per-email, so two runs inside a minute would trip
 * them and report confusing failures. Clearing the counters first makes the
 * script re-runnable.
 */
async function clearKeys(patterns) {
  if (!RESET) return null;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { Redis } = await import("ioredis");
    const redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    await redis.connect();
    const keys = [];
    for (const pattern of patterns) keys.push(...(await redis.keys(pattern)));
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    return keys.length;
  } catch (error) {
    console.log(`  (could not clear Redis keys: ${error.message})`);
    return null;
  }
}

async function resetThrottles() {
  const cleared = await clearKeys(["ratelimit:*", "login:*"]);
  if (cleared === null) {
    console.log("  (throttle counters not reset — re-run failures may be rate limits)");
  } else {
    console.log(`  cleared ${cleared} throttle key(s)`);
  }
}

// --- run -------------------------------------------------------------------

console.log(`\nVerifying auth against ${BASE}`);

const health = await call("GET", "/health").catch(() => null);
if (!health || health.status !== 200) {
  console.error(
    `\n[31mServer is not reachable at ${BASE}[0m\n` +
      `Start it with:  npm run dev\n`,
  );
  process.exit(1);
}

await resetThrottles();

const stamp = Date.now();
const testEmail = (label) => `${label}${stamp}@verify.example.ca`;

// --- internal provisioning -------------------------------------------------

section("Internal provisioning (org + first admin)");

const noToken = await call("POST", "/v1/internal/organizations", {
  body: { name: "x", admin: {} },
});
check("rejects a request with no service token", noToken.status === 401);

const wrongToken = await fetch(`${BASE}/v1/internal/organizations`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer wrong" },
  body: JSON.stringify({ name: "x", admin: {} }),
});
check("rejects a wrong service token", wrongToken.status === 401);

const created = await call("POST", "/v1/internal/organizations", {
  internal: true,
  body: {
    name: `Verify Pharmacy ${stamp}`,
    phone: "+15145550000",
    locale: "en",
    delivery_rate: 8.5,
    admin: {
      email: testEmail("admin"),
      password: "TestPassword123!",
      first_name: "Ada",
      last_name: "Lovelace",
    },
  },
});
check("creates an organization and its admin", created.status === 201, JSON.stringify(created.body));
check("delivery_rate round-trips as a number", created.body?.organization?.delivery_rate === 8.5);

const dupEmail = await call("POST", "/v1/internal/organizations", {
  internal: true,
  body: {
    name: `Verify Dup ${stamp}`,
    admin: {
      email: testEmail("admin"),
      password: "TestPassword123!",
      first_name: "A",
      last_name: "B",
    },
  },
});
check(
  "duplicate email surfaces EMAIL_ALREADY_REGISTERED, not a raw DB error",
  dupEmail.status === 409 && dupEmail.body?.error?.code === "EMAIL_ALREADY_REGISTERED",
  JSON.stringify(dupEmail.body),
);

// --- login -----------------------------------------------------------------

section("Login (PRD §4.2)");

const badPw = await call("POST", "/v1/auth/login", {
  body: { email: ORG_A_ADMIN, password: "definitely-wrong" },
});
check(
  "wrong password returns 401 INVALID_CREDENTIALS",
  badPw.status === 401 && badPw.body?.error?.code === "INVALID_CREDENTIALS",
  JSON.stringify(badPw.body),
);

const unknown = await call("POST", "/v1/auth/login", {
  body: { email: testEmail("nobody"), password: "definitely-wrong" },
});
check(
  "unknown email returns the identical error (no account enumeration)",
  unknown.status === 401 && unknown.body?.error?.code === "INVALID_CREDENTIALS",
);

const adminA = await call("POST", "/v1/auth/login", {
  body: { email: ORG_A_ADMIN, password: SEED_PASSWORD },
});
check("admin can log in", adminA.status === 200, JSON.stringify(adminA.body));
check("server returns the role so the client can route", adminA.body?.user?.role === "admin");
check("session carries organization_id", Boolean(adminA.body?.user?.organization_id));
check("access token expires in 15 minutes", adminA.body?.expires_in === 900);

const tokenA = adminA.body?.access_token;
const refreshA = adminA.body?.refresh_token;

const adminB = await call("POST", "/v1/auth/login", {
  body: { email: ORG_B_ADMIN, password: SEED_PASSWORD },
});
check("second organization's admin can log in", adminB.status === 200);
const tokenB = adminB.body?.access_token;

// --- me --------------------------------------------------------------------

section("Current user context");

check("GET /me without a token is 401", (await call("GET", "/v1/auth/me")).status === 401);
check(
  "GET /me with a garbage token is 401",
  (await call("GET", "/v1/auth/me", { token: "not.a.jwt" })).status === 401,
);

const me = await call("GET", "/v1/auth/me", { token: tokenA });
check(
  "GET /me returns the user and their organization",
  me.status === 200 && me.body?.organization?.name === "Pharmacie Saint-Laurent",
  JSON.stringify(me.body),
);
check("password hash is never serialized", !JSON.stringify(me.body ?? {}).includes("password"));

// --- invites ---------------------------------------------------------------

section("Invite codes and organization isolation (PRD §4.3, §4.4)");

const invite = await call("POST", "/v1/invites", { token: tokenA, body: {} });
check("admin can generate an invite code", invite.status === 201, JSON.stringify(invite.body));
const code = invite.body?.code;
check("code avoids ambiguous characters (no I, O, 0, 1)", /^[A-HJ-NP-Z2-9]{8}$/.test(code ?? ""), code);

const listA = await call("GET", "/v1/invites", { token: tokenA });
const listB = await call("GET", "/v1/invites", { token: tokenB });
check("organization A sees its own code", listA.body?.data?.some((c) => c.code === code));
check(
  "organization B cannot see organization A's code",
  !listB.body?.data?.some((c) => c.code === code),
  JSON.stringify(listB.body),
);

const inviteId = invite.body?.id;
const crossOrgDelete = await call("DELETE", `/v1/invites/${inviteId}`, { token: tokenB });
check(
  "organization B cannot delete organization A's code (404, not 403 — no existence leak)",
  crossOrgDelete.status === 404,
  JSON.stringify(crossOrgDelete.body),
);

// --- driver registration ---------------------------------------------------

section("Driver registration by invite code");

const reg = await call("POST", "/v1/auth/register/driver", {
  body: {
    code,
    email: testEmail("driver"),
    password: "DriverPassword123!",
    first_name: "Nouveau",
    last_name: "Livreur",
  },
});
check("driver registers with a valid code", reg.status === 201, JSON.stringify(reg.body));
check(
  "driver inherits the organization from the code, not from the request",
  reg.body?.organization_id === adminA.body?.user?.organization_id,
);

const reuse = await call("POST", "/v1/auth/register/driver", {
  body: {
    code,
    email: testEmail("second"),
    password: "DriverPassword123!",
    first_name: "Second",
    last_name: "Try",
  },
});
check(
  "a code is single-use (409 INVITE_CODE_REDEEMED)",
  reuse.status === 409 && reuse.body?.error?.code === "INVITE_CODE_REDEEMED",
  JSON.stringify(reuse.body),
);

const badCode = await call("POST", "/v1/auth/register/driver", {
  body: {
    code: "ZZZZZZZZ",
    email: testEmail("third"),
    password: "DriverPassword123!",
    first_name: "Third",
    last_name: "Try",
  },
});
check(
  "an unknown code is rejected (422 INVITE_CODE_INVALID)",
  badCode.status === 422 && badCode.body?.error?.code === "INVITE_CODE_INVALID",
  JSON.stringify(badCode.body),
);

// --- roles -----------------------------------------------------------------

section("Role enforcement");

const driverLogin = await call("POST", "/v1/auth/login", {
  body: { email: testEmail("driver"), password: "DriverPassword123!" },
});
check(
  "the new driver can log in and is reported as a driver",
  driverLogin.status === 200 && driverLogin.body?.user?.role === "driver",
  JSON.stringify(driverLogin.body),
);
const driverToken = driverLogin.body?.access_token;

const driverInvite = await call("POST", "/v1/invites", { token: driverToken, body: {} });
check(
  "a driver cannot generate invite codes (403)",
  driverInvite.status === 403 && driverInvite.body?.error?.code === "FORBIDDEN",
  JSON.stringify(driverInvite.body),
);

// --- refresh ---------------------------------------------------------------

section("Refresh rotation and reuse detection");

const rotated = await call("POST", "/v1/auth/refresh", { body: { refresh_token: refreshA } });
check("refresh returns a new session", rotated.status === 200, JSON.stringify(rotated.body));
check("the refresh token actually rotates", rotated.body?.refresh_token !== refreshA);

const replay = await call("POST", "/v1/auth/refresh", { body: { refresh_token: refreshA } });
check(
  "replaying a spent refresh token is rejected",
  replay.status === 401 && replay.body?.error?.code === "INVALID_REFRESH_TOKEN",
  JSON.stringify(replay.body),
);

const familyDead = await call("POST", "/v1/auth/refresh", {
  body: { refresh_token: rotated.body?.refresh_token },
});
check(
  "reuse detection revokes the whole token family",
  familyDead.status === 401,
  JSON.stringify(familyDead.body),
);

// --- logout ----------------------------------------------------------------

section("Logout");

const logoutSession = await call("POST", "/v1/auth/login", {
  body: { email: ORG_B_ADMIN, password: SEED_PASSWORD },
});
const loggedOut = await call("POST", "/v1/auth/logout", {
  body: { refresh_token: logoutSession.body?.refresh_token },
});
check("logout returns 204", loggedOut.status === 204, JSON.stringify(loggedOut.body));

const afterLogout = await call("POST", "/v1/auth/refresh", {
  body: { refresh_token: logoutSession.body?.refresh_token },
});
check("a revoked refresh token cannot be used", afterLogout.status === 401);

check(
  "logout is idempotent and does not confirm unknown tokens",
  (await call("POST", "/v1/auth/logout", { body: { refresh_token: "never-existed" } })).status === 204,
);

// --- password --------------------------------------------------------------

section("Password change");

const pwSession = await call("POST", "/v1/auth/login", {
  body: { email: ORG_B_ADMIN, password: SEED_PASSWORD },
});
const weak = await call("POST", "/v1/auth/password/change", {
  token: pwSession.body?.access_token,
  body: { current_password: SEED_PASSWORD, new_password: "short" },
});
check(
  "a too-short new password is rejected",
  weak.status === 400 && weak.body?.error?.code === "VALIDATION_FAILED",
  JSON.stringify(weak.body),
);

const wrongCurrent = await call("POST", "/v1/auth/password/change", {
  token: pwSession.body?.access_token,
  body: { current_password: "not-my-password", new_password: "BrandNewPassword123!" },
});
check(
  "the current password must be correct",
  wrongCurrent.status === 401 && wrongCurrent.body?.error?.code === "INVALID_CREDENTIALS",
  JSON.stringify(wrongCurrent.body),
);

// --- conventions -----------------------------------------------------------

section("API conventions (PRD §3)");

const healthRes = await fetch(`${BASE}/health`);
check("every response carries X-Request-Id", Boolean(healthRes.headers.get("x-request-id")));

const notFound = await call("GET", "/v1/does-not-exist");
check(
  "unknown routes use the standard error envelope",
  notFound.status === 404 && notFound.body?.error?.code === "NOT_FOUND",
  JSON.stringify(notFound.body),
);

const badBody = await call("POST", "/v1/auth/login", { body: { email: "not-an-email" } });
check(
  "validation failures return field-level details",
  badBody.status === 400 && Array.isArray(badBody.body?.error?.details?.fields),
  JSON.stringify(badBody.body),
);

// --- login throttle --------------------------------------------------------

/**
 * Runs last, and against the throwaway account created at the top of this
 * script rather than a seeded one: a successful throttle leaves that email
 * blocked for 60 seconds, which would break every later check.
 */
section("Failed-login throttle (PRD §4.2 — 5 attempts, then backoff)");

/**
 * Two independent controls guard login: a per-IP route limit (10/min) and the
 * per-email throttle the PRD specifies. From one machine the IP limit is the
 * tighter of the two and fires first, masking the email throttle entirely —
 * so clear the IP counters here to exercise the control actually under test.
 * The email counters are deliberately left alone.
 */
const clearedForThrottle = await clearKeys(["ratelimit:*"]);

if (clearedForThrottle === null) {
  console.log("  SKIP  needs REDIS_URL to isolate the per-email throttle from the IP limit");
} else {
  const throttleEmail = testEmail("admin");
  const statuses = [];
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const res = await call("POST", "/v1/auth/login", {
      body: { email: throttleEmail, password: "definitely-wrong" },
    });
    statuses.push(res.status === 429 ? res.body?.error?.code : res.status);
  }

  check(
    "the first five failures return 401, not a block",
    statuses.slice(0, 5).every((s) => s === 401),
    `got ${JSON.stringify(statuses)}`,
  );
  check(
    "the sixth attempt is throttled with LOGIN_THROTTLED",
    statuses[5] === "LOGIN_THROTTLED",
    `got ${JSON.stringify(statuses)}`,
  );
}

// --- summary ---------------------------------------------------------------

const colour = fail === 0 ? "[32m" : "[31m";
console.log(`\n${colour}${pass} passed, ${fail} failed[0m`);

if (failures.length > 0) {
  console.log("\nFailed checks:");
  for (const name of failures) console.log(`  - ${name}`);
}

if (throttled > 0) {
  console.log(
    `\nNote: ${throttled} request(s) hit the rate limiter. If failures look ` +
      `spurious, wait 60s and re-run, or allow the throttle reset (drop --no-reset).`,
  );
}

process.exit(fail > 0 ? 1 : 0);
