/**
 * Phase 3 smoke test — clients, orders, and the state machine over HTTP.
 *
 * Complements `verify-auth.mjs`. Driver-side transitions (pickup, complete,
 * return) have no HTTP surface until Phase 4, so they are exercised here by
 * their admin-visible effects and covered directly by the Vitest suite.
 *
 *   npm run verify:orders
 *
 * Requires: server running, migrations applied, and `npm run seed`.
 */
import { config as loadDotenv } from "dotenv";

loadDotenv();

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const SEED_PASSWORD = "DevPassword123!";
const ORG_A_ADMIN = "admin@stlaurent.example.ca";
const ORG_B_ADMIN = "admin@riverside.example.ca";

let pass = 0;
let fail = 0;
const failures = [];

async function call(method, path, { body, token } = {}) {
  const headers = body ? { "content-type": "application/json" } : {};
  if (token) headers.authorization = `Bearer ${token}`;

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
  return { status: res.status, body: parsed };
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
    // Non-fatal: worst case a later request is rate limited and says so.
  }
}

// --- setup -----------------------------------------------------------------

console.log(`\nVerifying clients and orders against ${BASE}`);

const health = await call("GET", "/health").catch(() => null);
if (!health || health.status !== 200) {
  console.error(`\n[31mServer is not reachable at ${BASE}[0m\nStart it with: npm run dev\n`);
  process.exit(1);
}

await clearRateLimits();

const stamp = Date.now();
const login = async (email) =>
  (await call("POST", "/v1/auth/login", { body: { email, password: SEED_PASSWORD } })).body;

const sessionA = await login(ORG_A_ADMIN);
const sessionB = await login(ORG_B_ADMIN);
const tokenA = sessionA?.access_token;
const tokenB = sessionB?.access_token;

if (!tokenA || !tokenB) {
  console.error("\n[31mCould not log in as the seeded admins. Run `npm run seed`.[0m\n");
  process.exit(1);
}

// --- clients ---------------------------------------------------------------

section("Clients (PRD §5.1)");

const created = await call("POST", "/v1/clients", {
  token: tokenA,
  body: {
    name: `Verify Patient ${stamp}`,
    address: "500 Rue Verify, Montréal, QC H2X 1Y4",
    phone_number: "+15145559999",
    notes: "Code de porte 4412",
  },
});
check("creates a client", created.status === 201, JSON.stringify(created.body));
const clientId = created.body?.id;

check(
  "surfaces the compliance reminder when notes are used",
  typeof created.body?.compliance_reminder === "string" &&
    created.body.compliance_reminder.toLowerCase().includes("medical"),
  JSON.stringify(created.body?.compliance_reminder),
);

const noNotes = await call("POST", "/v1/clients", {
  token: tokenA,
  body: {
    name: `No Notes ${stamp}`,
    address: "1 Quiet Street",
    phone_number: "+15145550001",
  },
});
check(
  "omits the reminder when notes are empty",
  noNotes.status === 201 && noNotes.body?.compliance_reminder === undefined,
);

const longNotes = await call("POST", "/v1/clients", {
  token: tokenA,
  body: {
    name: `Too Long ${stamp}`,
    address: "1 Long Street",
    phone_number: "+15145550002",
    notes: "x".repeat(501),
  },
});
check(
  "enforces the 500-character notes limit",
  longNotes.status === 400 && longNotes.body?.error?.code === "VALIDATION_FAILED",
  JSON.stringify(longNotes.body),
);

const search = await call("GET", `/v1/clients?search=Verify Patient ${stamp}`, {
  token: tokenA,
});
check(
  "searches by name",
  search.status === 200 && search.body?.data?.some((c) => c.id === clientId),
  JSON.stringify(search.body),
);

const searchOtherOrg = await call("GET", `/v1/clients?search=Verify Patient ${stamp}`, {
  token: tokenB,
});
check(
  "search cannot reach another organization's clients",
  searchOtherOrg.status === 200 && searchOtherOrg.body?.data?.length === 0,
  JSON.stringify(searchOtherOrg.body),
);

// --- order creation and snapshotting ---------------------------------------

section("Orders — creation and snapshotting (PRD §5.2)");

const order = await call("POST", "/v1/orders", {
  token: tokenA,
  body: {
    client_id: clientId,
    delivery_date: "2026-09-15",
    delivery_window: "AM",
    amount_due: 42.5,
    requires_cooler_bag: true,
  },
});
check("creates an order from a client", order.status === 201, JSON.stringify(order.body));
const orderId = order.body?.id;

check(
  "snapshots the client's name, address and phone onto the order",
  order.body?.patient_name === `Verify Patient ${stamp}` &&
    order.body?.address?.startsWith("500 Rue Verify") &&
    order.body?.phone_number === "+15145559999",
  JSON.stringify(order.body),
);
check("stores amount_due as a number", order.body?.amount_due === 42.5);
check(
  "starts scheduled and unpaid — the calendar, not the counter",
  order.body?.status === "scheduled" && order.body?.payment_status === "unpaid",
  JSON.stringify(order.body?.status),
);

// The heart of §5.2: editing the client must not rewrite delivery history.
await call("PATCH", `/v1/clients/${clientId}`, {
  token: tokenA,
  body: { address: "999 Moved Away Blvd", name: "Renamed Entirely" },
});
const afterClientEdit = await call("GET", `/v1/orders/${orderId}`, { token: tokenA });
check(
  "editing the client does NOT rewrite the existing order's snapshot",
  afterClientEdit.body?.address?.startsWith("500 Rue Verify") &&
    afterClientEdit.body?.patient_name === `Verify Patient ${stamp}`,
  JSON.stringify({
    address: afterClientEdit.body?.address,
    name: afterClientEdit.body?.patient_name,
  }),
);

const newOrder = await call("POST", "/v1/orders", {
  token: tokenA,
  body: { client_id: clientId, delivery_date: "2026-09-16", delivery_window: "PM" },
});
check(
  "a NEW order picks up the client's current details",
  newOrder.body?.address === "999 Moved Away Blvd",
  JSON.stringify(newOrder.body?.address),
);

const override = await call("POST", "/v1/orders", {
  token: tokenA,
  body: {
    client_id: clientId,
    delivery_date: "2026-09-17",
    delivery_window: "AM",
    address: "Apartment 4B, 999 Moved Away Blvd",
  },
});
check(
  "per-order address override is honoured",
  override.body?.address === "Apartment 4B, 999 Moved Away Blvd",
);

check(
  "the creation event is recorded on the timeline",
  afterClientEdit.body?.status_events?.length === 1 &&
    afterClientEdit.body.status_events[0].status === "scheduled",
  JSON.stringify(afterClientEdit.body?.status_events),
);
check(
  "detail exposes the transitions available from here",
  Array.isArray(afterClientEdit.body?.available_transitions) &&
    afterClientEdit.body.available_transitions.sort().join(",") === "cancel,mark_ready",
  JSON.stringify(afterClientEdit.body?.available_transitions),
);

// --- edits and assignment --------------------------------------------------

section("Orders — edits and assignment");

const edited = await call("PATCH", `/v1/orders/${orderId}`, {
  token: tokenA,
  body: { delivery_window: "PM", amount_due: 30 },
});
check(
  "edits are allowed before a driver takes the package",
  edited.status === 200 && edited.body?.delivery_window === "PM" && edited.body?.amount_due === 30,
  JSON.stringify(edited.body),
);

const drivers = await call("GET", "/v1/orders?limit=1", { token: tokenA });
check("order list responds", drivers.status === 200);

const foreignDriver = await call("POST", `/v1/orders/${orderId}/assign`, {
  token: tokenA,
  body: { driver_id: "00000000-0000-0000-0000-000000000000" },
});
check(
  "refuses to assign an unknown driver",
  foreignDriver.status === 404,
  JSON.stringify(foreignDriver.body),
);

// --- state machine ---------------------------------------------------------

section("State machine (PRD §5.3)");

const cancelTarget = await call("POST", "/v1/orders", {
  token: tokenA,
  body: { client_id: clientId, delivery_date: "2026-09-18", delivery_window: "AM" },
});
const cancelled = await call("POST", `/v1/orders/${cancelTarget.body?.id}/cancel`, {
  token: tokenA,
});
check(
  "cancels an order that never left the pharmacy",
  cancelled.status === 200 && cancelled.body?.status === "cancelled",
  JSON.stringify(cancelled.body),
);
check(
  "cancellation writes its timestamp in the same update",
  Boolean(cancelled.body?.cancelled_at),
  JSON.stringify(cancelled.body?.cancelled_at),
);

const doubleCancel = await call("POST", `/v1/orders/${cancelTarget.body?.id}/cancel`, {
  token: tokenA,
});
check(
  "a cancelled order is terminal and immutable",
  doubleCancel.status === 409 && doubleCancel.body?.error?.code === "ORDER_ALREADY_TERMINAL",
  JSON.stringify(doubleCancel.body),
);

const editCancelled = await call("PATCH", `/v1/orders/${cancelTarget.body?.id}`, {
  token: tokenA,
  body: { delivery_window: "PM" },
});
check(
  "a cancelled order cannot be edited",
  editCancelled.status === 422 && editCancelled.body?.error?.code === "ORDER_NOT_EDITABLE",
  JSON.stringify(editCancelled.body),
);

const cancelledDetail = await call("GET", `/v1/orders/${cancelTarget.body?.id}`, {
  token: tokenA,
});
check(
  "a terminal order offers no further transitions",
  cancelledDetail.body?.available_transitions?.length === 0,
  JSON.stringify(cancelledDetail.body?.available_transitions),
);
check(
  "the cancellation is on the audit timeline",
  cancelledDetail.body?.status_events?.map((e) => e.status).join(",") === "scheduled,cancelled",
  JSON.stringify(cancelledDetail.body?.status_events),
);

// --- listing ---------------------------------------------------------------

section("Order listing and filters");

const byDate = await call("GET", "/v1/orders?date=2026-09-15", { token: tokenA });
check(
  "filters by delivery date",
  byDate.status === 200 && byDate.body?.data?.every((o) => o.delivery_date === "2026-09-15"),
  JSON.stringify(byDate.body?.data?.map((o) => o.delivery_date)),
);

const byStatus = await call("GET", "/v1/orders?status=cancelled", { token: tokenA });
check(
  "filters by status",
  byStatus.status === 200 && byStatus.body?.data?.every((o) => o.status === "cancelled"),
);

const paged = await call("GET", "/v1/orders?limit=2", { token: tokenA });
check(
  "paginates with a cursor",
  paged.status === 200 && paged.body?.data?.length <= 2 && "next_cursor" in (paged.body ?? {}),
  JSON.stringify({ len: paged.body?.data?.length, has_more: paged.body?.has_more }),
);

if (paged.body?.next_cursor) {
  const next = await call(
    "GET",
    `/v1/orders?limit=2&cursor=${encodeURIComponent(paged.body.next_cursor)}`,
    { token: tokenA },
  );
  const firstIds = paged.body.data.map((o) => o.id);
  check(
    "the second page does not repeat the first",
    next.status === 200 && !next.body?.data?.some((o) => firstIds.includes(o.id)),
  );
}

const badCursor = await call("GET", "/v1/orders?cursor=garbage", { token: tokenA });
check(
  "a malformed cursor is rejected, not ignored",
  badCursor.status === 400 && badCursor.body?.error?.code === "INVALID_CURSOR",
  JSON.stringify(badCursor.body),
);

const updatedSince = await call(
  "GET",
  `/v1/orders?updated_since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
  { token: tokenA },
);
check(
  "updated_since supports the polling fallback",
  updatedSince.status === 200 && updatedSince.body?.data?.length === 0,
  JSON.stringify(updatedSince.body?.data?.length),
);

// --- isolation -------------------------------------------------------------

section("Organization isolation (PRD §4.4)");

check(
  "another organization cannot read the order",
  (await call("GET", `/v1/orders/${orderId}`, { token: tokenB })).status === 404,
);
check(
  "another organization cannot edit the order",
  (await call("PATCH", `/v1/orders/${orderId}`, { token: tokenB, body: { delivery_window: "AM" } }))
    .status === 404,
);
check(
  "another organization cannot cancel the order",
  (await call("POST", `/v1/orders/${orderId}/cancel`, { token: tokenB })).status === 404,
);
check(
  "another organization cannot read the client",
  (await call("GET", `/v1/clients/${clientId}`, { token: tokenB })).status === 404,
);
check(
  "another organization cannot create an order against the client",
  (
    await call("POST", "/v1/orders", {
      token: tokenB,
      body: { client_id: clientId, delivery_date: "2026-09-20", delivery_window: "AM" },
    })
  ).status === 404,
);

const stillIntact = await call("GET", `/v1/orders/${orderId}`, { token: tokenA });
check(
  "after all of that, the order is untouched",
  stillIntact.body?.status === "scheduled" && stillIntact.body?.delivery_window === "PM",
  JSON.stringify({ status: stillIntact.body?.status, window: stillIntact.body?.delivery_window }),
);

// --- soft delete -----------------------------------------------------------

section("Client soft delete (PRD §5.1)");

const deleted = await call("DELETE", `/v1/clients/${clientId}`, { token: tokenA });
check("deactivating a client returns 204", deleted.status === 204, JSON.stringify(deleted.body));

const afterDelete = await call("GET", `/v1/clients/${clientId}`, { token: tokenA });
check(
  "the client row survives with is_active false (never hard-deleted)",
  afterDelete.status === 200 && afterDelete.body?.is_active === false,
  JSON.stringify(afterDelete.body),
);

const historyIntact = await call("GET", `/v1/orders/${orderId}`, { token: tokenA });
check(
  "delivery history for a deactivated client is still readable",
  historyIntact.status === 200,
);

const orderForDeleted = await call("POST", "/v1/orders", {
  token: tokenA,
  body: { client_id: clientId, delivery_date: "2026-09-21", delivery_window: "AM" },
});
check(
  "no new deliveries can be created for a deactivated client",
  orderForDeleted.status === 422 && orderForDeleted.body?.error?.code === "CLIENT_INACTIVE",
  JSON.stringify(orderForDeleted.body),
);


// --- the ready transition --------------------------------------------------

section("Declaring an order ready (domain workflow: avant prise en charge)");

const readyClient = await call("POST", "/v1/clients", {
  token: tokenA,
  body: {
    // A client of its own: the shared one is soft-deleted by the deletion
    // checks above, and an inactive client cannot take new deliveries.
    name: `Ready Flow Patient ${stamp}`,
    address: "800 Rue Ready, Montréal, QC H2X 1Y4",
    phone_number: "+15145558888",
  },
});

const readyTarget = await call("POST", "/v1/orders", {
  token: tokenA,
  body: {
    client_id: readyClient.body?.id,
    delivery_date: "2026-09-15",
    delivery_window: "AM",
    packages: [{ label_code: "RDY-1" }],
  },
});

const readyRes = await call("POST", `/v1/orders/${readyTarget.body?.id}/ready`, {
  token: tokenA,
});
check(
  "ready moves a scheduled order onto the counter",
  readyRes.status === 200 && readyRes.body?.status === "in_pharmacy",
  JSON.stringify(readyRes.body?.status ?? readyRes.body),
);
check("ready stamps ready_at", Boolean(readyRes.body?.ready_at));

const readyTwice = await call("POST", `/v1/orders/${readyTarget.body?.id}/ready`, {
  token: tokenA,
});
check(
  "an order cannot be declared ready twice",
  readyTwice.status === 409,
  JSON.stringify(readyTwice.body),
);

const scheduledTransitions = await call("GET", `/v1/orders/${order.body?.id}`, {
  token: tokenA,
});
check(
  "a scheduled order offers mark_ready and cancel",
  JSON.stringify(
    [...(scheduledTransitions.body?.available_transitions ?? [])].sort(),
  ) === JSON.stringify(["cancel", "mark_ready"]),
  JSON.stringify(scheduledTransitions.body?.available_transitions),
);

const calendarRes = await call(
  "GET",
  "/v1/orders/calendar?from=2026-09-01&to=2026-09-30",
  { token: tokenA },
);
check(
  "the calendar returns per-day counts",
  calendarRes.status === 200 && Array.isArray(calendarRes.body?.days),
  JSON.stringify(calendarRes.body).slice(0, 200),
);
check(
  "the calendar ships counts, not patient records",
  !JSON.stringify(calendarRes.body ?? {}).includes("patient_name"),
);

const badRange = await call(
  "GET",
  "/v1/orders/calendar?from=2026-09-30&to=2026-09-01",
  { token: tokenA },
);
check(
  "the calendar refuses a backwards range",
  badRange.status === 400,
  JSON.stringify(badRange.body),
);

// --- summary ---------------------------------------------------------------

const colour = fail === 0 ? "[32m" : "[31m";
console.log(`\n${colour}${pass} passed, ${fail} failed[0m`);
if (failures.length > 0) {
  console.log("\nFailed checks:");
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(fail > 0 ? 1 : 0);
