/**
 * Phase 4 smoke test — the driver flow over HTTP.
 *
 * Walks a real delivery day: queue, route optimization, pickup, payment,
 * completion, cooler check, and a return — checking at each step that patient
 * details vanish from the driver's view the moment a delivery closes.
 *
 *   npm run verify:driver
 *
 * Requires: server running, migrations applied, and `npm run seed`.
 */
import { config as loadDotenv } from "dotenv";

loadDotenv();

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const SEED_PASSWORD = "DevPassword123!";
const ADMIN_A = "admin@stlaurent.example.ca";
const DRIVER_A = "driver@stlaurent.example.ca";
const DRIVER_B = "driver@riverside.example.ca";

let pass = 0;
let fail = 0;
const failures = [];

async function call(method, path, { body, token, idempotencyKey } = {}) {
  const headers = body ? { "content-type": "application/json" } : {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

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
    console.log(`  [32mPASS[0m  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  [31mFAIL[0m  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
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
    // Non-fatal.
  }
}

// --- setup -----------------------------------------------------------------

console.log(`\nVerifying the driver flow against ${BASE}`);

const health = await call("GET", "/health").catch(() => null);
if (!health || health.status !== 200) {
  console.error(`\n[31mServer is not reachable at ${BASE}[0m\nStart it with: npm run dev\n`);
  process.exit(1);
}

await clearRateLimits();

const login = async (email) =>
  (await call("POST", "/v1/auth/login", { body: { email, password: SEED_PASSWORD } })).body;

const adminSession = await login(ADMIN_A);
const driverSession = await login(DRIVER_A);
const otherDriverSession = await login(DRIVER_B);

const adminToken = adminSession?.access_token;
const driverToken = driverSession?.access_token;
const otherDriverToken = otherDriverSession?.access_token;
const driverId = driverSession?.user?.id;

if (!adminToken || !driverToken || !otherDriverToken) {
  console.error("\n[31mCould not log in as the seeded accounts. Run `npm run seed`.[0m\n");
  process.exit(1);
}

const stamp = Date.now();

/**
 * Each run books its stops on its own delivery date.
 *
 * The queue is "this driver's active stops for a day", so a fixed date would
 * accumulate leftovers from previous runs and make the stop counts drift. A
 * date derived from the clock keeps every run isolated without deleting
 * anything.
 */
const DAY_OFFSET = 30 + (stamp % 3650);
const DATE = new Date(Date.now() + DAY_OFFSET * 86_400_000)
  .toISOString()
  .slice(0, 10);

const client = await call("POST", "/v1/clients", {
  token: adminToken,
  body: {
    name: `Driver Flow Patient ${stamp}`,
    address: "700 Rue Verify, Montréal, QC H2X 1Y4",
    phone_number: "+15145557777",
  },
});
const clientId = client.body?.id;

async function newOrder(overrides = {}) {
  const res = await call("POST", "/v1/orders", {
    token: adminToken,
    body: {
      client_id: clientId,
      driver_id: driverId,
      delivery_date: DATE,
      delivery_window: "AM",
      ...overrides,
    },
  });
  return res.body;
}

// --- queue -----------------------------------------------------------------

section("Driver queue (PRD §5.4)");

const deliverOrder = await newOrder({ address: "300 Cedar St", amount_due: 42.5 });
const returnOrder = await newOrder({ address: "100 Ash St" });
const coolerOrder = await newOrder({ address: "200 Birch St", requires_cooler_bag: true });

const queue = await call("GET", `/v1/driver/queue?date=${DATE}`, { token: driverToken });
check("driver can fetch the queue", queue.status === 200, JSON.stringify(queue.body));
check("queue holds the three assigned stops", queue.body?.stops?.length === 3, `got ${queue.body?.stops?.length}`);
check(
  "queue carries the pharmacy phone for one-tap dialling",
  Boolean(queue.body?.pharmacy?.phone),
  JSON.stringify(queue.body?.pharmacy),
);
check(
  "active stops include patient name, address and phone",
  queue.body?.stops?.every((s) => s.patient_name && s.address && s.phone_number),
  JSON.stringify(queue.body?.stops?.[0]),
);

const adminQueue = await call("GET", `/v1/driver/queue?date=${DATE}`, { token: adminToken });
check("an admin token is refused on driver routes", adminQueue.status === 403);

const foreignQueue = await call("GET", `/v1/driver/queue?date=${DATE}`, {
  token: otherDriverToken,
});
check(
  "a driver from another organization sees nothing",
  foreignQueue.status === 200 && foreignQueue.body?.stops?.length === 0,
  JSON.stringify(foreignQueue.body?.stops?.length),
);

// --- optimization ----------------------------------------------------------

section("Route optimization (PRD §5.4)");

const optimized = await call("POST", "/v1/driver/queue/optimize", {
  token: driverToken,
  body: { date: DATE, current_location: { latitude: 45.5017, longitude: -73.5673 } },
});
check("optimize returns the resequenced queue", optimized.status === 200, JSON.stringify(optimized.body?.error));
check("optimize reports it was not degraded", optimized.body?.degraded === false);
check(
  "stops are numbered 1..N",
  JSON.stringify(optimized.body?.stops?.map((s) => s.sequence_number)) === "[1,2,3]",
  JSON.stringify(optimized.body?.stops?.map((s) => s.sequence_number)),
);
check(
  "the fake optimizer reordered the stops by address",
  JSON.stringify(optimized.body?.stops?.map((s) => s.address)) ===
    JSON.stringify(["100 Ash St", "200 Birch St", "300 Cedar St"]),
  JSON.stringify(optimized.body?.stops?.map((s) => s.address)),
);

const reoptimized = await call("POST", "/v1/driver/queue/optimize", {
  token: driverToken,
  body: { date: DATE },
});
check(
  "re-optimizing does not collide on the sequence index",
  reoptimized.status === 200,
  JSON.stringify(reoptimized.body?.error),
);

// --- the delivery ----------------------------------------------------------

section("A delivery: pickup → payment → completion");

const earlyComplete = await call("POST", `/v1/driver/orders/${deliverOrder.id}/complete`, {
  token: driverToken,
});
check(
  "cannot complete an order that was never picked up",
  earlyComplete.status === 409 && earlyComplete.body?.error?.code === "ORDER_INVALID_TRANSITION",
  JSON.stringify(earlyComplete.body),
);

const pickedUp = await call("POST", `/v1/driver/orders/${deliverOrder.id}/pickup`, {
  token: driverToken,
});
check("pickup succeeds", pickedUp.status === 200 && pickedUp.body?.status === "picked_up", JSON.stringify(pickedUp.body));
check("pickup stamps picked_up_at", Boolean(pickedUp.body?.picked_up_at));
check("an in-progress stop still shows patient details", Boolean(pickedUp.body?.patient_name));

const badPayment = await call("POST", `/v1/driver/orders/${deliverOrder.id}/payment`, {
  token: driverToken,
  body: { payment_method: "cash" },
});
check(
  "payment without an amount is a field-level error, not a constraint failure",
  badPayment.status === 400 &&
    badPayment.body?.error?.code === "VALIDATION_FAILED" &&
    Array.isArray(badPayment.body?.error?.details?.fields),
  JSON.stringify(badPayment.body),
);

const payment = await call("POST", `/v1/driver/orders/${deliverOrder.id}/payment`, {
  token: driverToken,
  body: { payment_method: "card", amount_collected: 42.5 },
});
check("records the collection", payment.status === 200, JSON.stringify(payment.body));
check("reconciles against amount_due", payment.body?.matches_amount_due === true);

const doublePayment = await call("POST", `/v1/driver/orders/${deliverOrder.id}/payment`, {
  token: driverToken,
  body: { payment_method: "card", amount_collected: 42.5 },
});
check(
  "refuses a second collection",
  doublePayment.status === 422 && doublePayment.body?.error?.code === "PAYMENT_ALREADY_COLLECTED",
  JSON.stringify(doublePayment.body),
);

const completed = await call("POST", `/v1/driver/orders/${deliverOrder.id}/complete`, {
  token: driverToken,
});
check("one-tap completion succeeds", completed.status === 200 && completed.body?.status === "completed");
check("completion stamps completed_at", Boolean(completed.body?.completed_at));

// --- PII minimization ------------------------------------------------------

section("PII minimization on the driver device (PRD §8.3)");

check(
  "the completed order carries NO patient name",
  !("patient_name" in (completed.body ?? {})),
  JSON.stringify(Object.keys(completed.body ?? {})),
);
check("the completed order carries NO address", !("address" in (completed.body ?? {})));
check("the completed order carries NO phone number", !("phone_number" in (completed.body ?? {})));
check(
  "no patient data survives anywhere in the payload",
  !JSON.stringify(completed.body ?? {}).includes("Driver Flow Patient") &&
    !JSON.stringify(completed.body ?? {}).includes("700 Rue Verify"),
);

const queueAfter = await call("GET", `/v1/driver/queue?date=${DATE}`, { token: driverToken });
check(
  "the closed delivery leaves the active stop list",
  queueAfter.body?.stops?.every((s) => s.id !== deliverOrder.id),
);
check(
  "the closed list is PII-free too",
  !JSON.stringify(queueAfter.body?.closed ?? []).includes("Driver Flow Patient"),
  JSON.stringify(queueAfter.body?.closed?.[0]),
);

const adminView = await call("GET", `/v1/orders/${deliverOrder.id}`, { token: adminToken });
check(
  "the admin still sees the full record for history and reporting",
  adminView.status === 200 && adminView.body?.patient_name === `Driver Flow Patient ${stamp}`,
  JSON.stringify(adminView.body?.patient_name),
);

// --- return ----------------------------------------------------------------

section("Returning an undeliverable order (PRD §5.3)");

const earlyReturn = await call("POST", `/v1/driver/orders/${returnOrder.id}/return`, {
  token: driverToken,
});
check(
  "cannot return an order still at the pharmacy (that is a cancellation)",
  earlyReturn.status === 409,
  JSON.stringify(earlyReturn.body),
);

await call("POST", `/v1/driver/orders/${returnOrder.id}/pickup`, { token: driverToken });
const returned = await call("POST", `/v1/driver/orders/${returnOrder.id}/return`, {
  token: driverToken,
});
check("return succeeds from picked_up", returned.status === 200 && returned.body?.status === "returned");
check("return stamps returned_at", Boolean(returned.body?.returned_at));
check("return strips patient details as well", !("address" in (returned.body ?? {})));

const returnAdmin = await call("GET", `/v1/orders/${returnOrder.id}`, { token: adminToken });
check(
  "a returned order stays unpaid — nothing was collected",
  returnAdmin.body?.payment_status === "unpaid" && returnAdmin.body?.payment_collected === false,
  JSON.stringify({
    status: returnAdmin.body?.payment_status,
    collected: returnAdmin.body?.payment_collected,
  }),
);

const payReturned = await call("POST", `/v1/driver/orders/${returnOrder.id}/payment`, {
  token: driverToken,
  body: { payment_method: "cash", amount_collected: 10 },
});
check("payment on a returned order is refused", payReturned.status === 409, JSON.stringify(payReturned.body));

// --- cooler bag ------------------------------------------------------------

section("Cooler bag quality check (PRD §5.6)");

const earlyCooler = await call("POST", `/v1/driver/orders/${coolerOrder.id}/cooler-check`, {
  token: driverToken,
  body: { confirmed: true },
});
check("the check is refused before the delivery closes", earlyCooler.status === 409);

await call("POST", `/v1/driver/orders/${coolerOrder.id}/pickup`, { token: driverToken });
const coolerCompleted = await call("POST", `/v1/driver/orders/${coolerOrder.id}/complete`, {
  token: driverToken,
});
check(
  "completion is never blocked by an outstanding cooler check",
  coolerCompleted.status === 200 && coolerCompleted.body?.cooler_bag_confirmed === null,
  JSON.stringify(coolerCompleted.body?.cooler_bag_confirmed),
);

const cooler = await call("POST", `/v1/driver/orders/${coolerOrder.id}/cooler-check`, {
  token: driverToken,
  body: { confirmed: true },
});
check("the check records a confirmation", cooler.status === 200 && cooler.body?.cooler_bag_confirmed === true);

const notRequired = await call("POST", `/v1/driver/orders/${deliverOrder.id}/cooler-check`, {
  token: driverToken,
  body: { confirmed: true },
});
check(
  "the check is refused when no cooler bag was required",
  notRequired.status === 422 && notRequired.body?.error?.code === "COOLER_BAG_NOT_REQUIRED",
  JSON.stringify(notRequired.body),
);

// --- idempotency -----------------------------------------------------------

section("Idempotent retries (PRD §3)");

const retryOrder = await newOrder({ address: "400 Dogwood St", amount_due: 15 });
await call("POST", `/v1/driver/orders/${retryOrder.id}/pickup`, { token: driverToken });

const key = `verify-${stamp}`;
const firstPay = await call("POST", `/v1/driver/orders/${retryOrder.id}/payment`, {
  token: driverToken,
  idempotencyKey: key,
  body: { payment_method: "cash", amount_collected: 15 },
});
const retryPay = await call("POST", `/v1/driver/orders/${retryOrder.id}/payment`, {
  token: driverToken,
  idempotencyKey: key,
  body: { payment_method: "cash", amount_collected: 15 },
});

check("the first payment succeeds", firstPay.status === 200, JSON.stringify(firstPay.body));
check(
  "the retry replays the stored response instead of erroring",
  retryPay.status === 200 && retryPay.headers.get("idempotent-replay") === "true",
  JSON.stringify({ status: retryPay.status, replay: retryPay.headers.get("idempotent-replay") }),
);
check(
  "the replayed body is identical",
  JSON.stringify(retryPay.body) === JSON.stringify(firstPay.body),
);

const conflicting = await call("POST", `/v1/driver/orders/${retryOrder.id}/payment`, {
  token: driverToken,
  idempotencyKey: key,
  body: { payment_method: "card", amount_collected: 999 },
});
check(
  "the same key with a different payload is a conflict, not a replay",
  conflicting.status === 409 && conflicting.body?.error?.code === "IDEMPOTENCY_KEY_CONFLICT",
  JSON.stringify(conflicting.body),
);

const withoutKey = await call("POST", `/v1/driver/orders/${retryOrder.id}/payment`, {
  token: driverToken,
  body: { payment_method: "cash", amount_collected: 15 },
});
check(
  "without a key the same retry is caught by the business rule instead",
  withoutKey.status === 422 && withoutKey.body?.error?.code === "PAYMENT_ALREADY_COLLECTED",
  JSON.stringify(withoutKey.body),
);

// --- driver isolation ------------------------------------------------------

section("Driver-level isolation (PRD §4.4)");

const stranded = await newOrder({ address: "500 Elm St" });

for (const [label, path, body] of [
  ["pickup", `/v1/driver/orders/${stranded.id}/pickup`, undefined],
  ["complete", `/v1/driver/orders/${stranded.id}/complete`, undefined],
  ["return", `/v1/driver/orders/${stranded.id}/return`, undefined],
  [
    "payment",
    `/v1/driver/orders/${stranded.id}/payment`,
    { payment_method: "cash", amount_collected: 5 },
  ],
  ["cooler-check", `/v1/driver/orders/${stranded.id}/cooler-check`, { confirmed: true }],
]) {
  const res = await call("POST", path, { token: otherDriverToken, body });
  check(`another organization's driver gets 404 on ${label}`, res.status === 404, JSON.stringify(res.body));
}

const untouched = await call("GET", `/v1/orders/${stranded.id}`, { token: adminToken });
check(
  "after all of that the order is untouched",
  untouched.body?.status === "in_pharmacy",
  JSON.stringify(untouched.body?.status),
);

// --- summary ---------------------------------------------------------------

const colour = fail === 0 ? "[32m" : "[31m";
console.log(`\n${colour}${pass} passed, ${fail} failed[0m`);
if (failures.length > 0) {
  console.log("\nFailed checks:");
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(fail > 0 ? 1 : 0);
