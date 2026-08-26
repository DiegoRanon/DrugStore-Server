# Testing Phase 4 — Driver Flow

Covers PRD §5.4 (queue and route optimization), §5.5 (payments), §5.6 (cooler bag QC), §5.7 (one-tap calling), §8.3 (PII minimization on the driver device), and §3 (idempotent retries). Assumes the stack from [TESTING-AUTH.md](TESTING-AUTH.md) §1 is running.

---

## 1. The fast way

```bash
npm test                # 128 unit + integration tests
npm run verify:driver   # 49 black-box HTTP checks
npm run verify          # all three black-box suites (130 checks)
```

The driver script books its stops on a delivery date derived from the clock, so repeat runs stay isolated from each other without deleting anything.

---

## 2. The endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/driver/queue?date=` | Active stops, in route order |
| POST | `/v1/driver/queue/optimize` | Recalculate the stop order |
| POST | `/v1/driver/orders/:id/pickup` | Take custody → `picked_up` |
| POST | `/v1/driver/orders/:id/complete` | One-tap PoD → `completed` |
| POST | `/v1/driver/orders/:id/return` | Patient unavailable → `returned` |
| POST | `/v1/driver/orders/:id/payment` | Record a POS collection |
| POST | `/v1/driver/orders/:id/cooler-check` | Post-delivery QC |

All mutations accept `Idempotency-Key`.

---

## 3. Manual walkthrough

```bash
DRIVER=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"driver@stlaurent.example.ca","password":"DevPassword123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
```

You will also want an admin token (see [TESTING-AUTH.md](TESTING-AUTH.md) §4.2) to create and assign orders.

### 3.1 The queue

```bash
curl -s "http://localhost:3000/v1/driver/queue?date=2026-09-15" \
  -H "authorization: Bearer $DRIVER"
```

Returns:

- `stops` — active deliveries only, ordered by `sequence_number` (unsequenced stops sort **last**, because a NULL means "not yet placed", not "position zero")
- `closed` — deliveries finished that day, with no patient data
- `pharmacy` — name and phone, so the app can invoke the native dialer (§5.7). There is no server telephony.

A driver only ever sees orders where `driver_id` is themselves — not just their organization's. An admin token on any driver route gets **403**.

### 3.2 Optimize the route

```bash
curl -s -X POST http://localhost:3000/v1/driver/queue/optimize \
  -H "authorization: Bearer $DRIVER" -H 'content-type: application/json' \
  -d '{"date":"2026-09-15","current_location":{"latitude":45.5017,"longitude":-73.5673}}'
```

Writes `sequence_number` 1..N and returns the reordered queue with `degraded: false`.

**The degradation path is the part worth understanding.** §5.4 says a provider failure must never block a driver, so the endpoint never returns an error for one — it keeps the previous sequence and sets `degraded: true`. The service also rejects a response that drops or invents stops, on the grounds that a provider returning the wrong number of stops cannot be trusted for that run. `test/integration/driver.test.ts` proves this by injecting a `FailingOptimizer`.

> The real Mapbox adapter is Phase 5. The port and the degradation contract exist now, so Phase 5 adds an implementation rather than reworking this.

### 3.3 A delivery

```bash
curl -s -X POST http://localhost:3000/v1/driver/orders/ORDER_ID/pickup -H "authorization: Bearer $DRIVER"
curl -s -X POST http://localhost:3000/v1/driver/orders/ORDER_ID/payment \
  -H "authorization: Bearer $DRIVER" -H 'content-type: application/json' \
  -d '{"payment_method":"card","amount_collected":42.50}'
curl -s -X POST http://localhost:3000/v1/driver/orders/ORDER_ID/complete -H "authorization: Bearer $DRIVER"
```

Payment sets `payment_collected`, `payment_collected_at` and `payment_status = 'paid'` together — clients never write `payment_status` directly (§5.5). The response includes `matches_amount_due`; a mismatch is **not** an error, because partial payments happen at the door, but it is flagged and logged so the pharmacy can reconcile.

Omitting `amount_collected` returns a **400 with field-level details**, never the raw `chk_payment_collected_details` constraint failure.

### 3.4 The PII test — the one worth doing yourself

Look at the pickup response, then the completion response:

```bash
curl -s -X POST http://localhost:3000/v1/driver/orders/ORDER_ID/pickup   -H "authorization: Bearer $DRIVER" | node -pe 'Object.keys(JSON.parse(require("fs").readFileSync(0)))'
curl -s -X POST http://localhost:3000/v1/driver/orders/ORDER_ID/complete -H "authorization: Bearer $DRIVER" | node -pe 'Object.keys(JSON.parse(require("fs").readFileSync(0)))'
```

The active response has `patient_name`, `address`, `phone_number`. **The completed one has no such keys at all** — not nulls, absent. Re-fetch the queue and the closed delivery is equally bare.

Then confirm the data still exists for the pharmacy:

```bash
curl -s http://localhost:3000/v1/orders/ORDER_ID -H "authorization: Bearer $ADMIN_TOKEN"
```

The row persists server-side for admin history and reporting (§8.3). What changed is who the server will hand it to.

This is enforced by the type system: `DriverOrderView` is a union whose terminal branch has no PII fields, and driver routes are typed to return it — so leaking on a closed delivery is a compile error, not something review has to catch.

### 3.5 Return an undeliverable order

```bash
curl -s -X POST http://localhost:3000/v1/driver/orders/ORDER_ID/return -H "authorization: Bearer $DRIVER"
```

Only reachable from `picked_up` — an order still at the pharmacy is **cancelled** by an admin, not returned, because a return means a package physically travelled and came back.

A returned order **stays unpaid**: the driver never reached the patient, so nothing was collected (§5.3). Recording payment against one is refused.

### 3.6 Cooler bag check

```bash
curl -s -X POST http://localhost:3000/v1/driver/orders/ORDER_ID/cooler-check \
  -H "authorization: Bearer $DRIVER" -H 'content-type: application/json' \
  -d '{"confirmed":true}'
```

Only for orders with `requires_cooler_bag` (else **422**), and only after the delivery closes (else **409**).

Three distinct states, which matters for the §5.10 exceptions report:

| `cooler_bag_confirmed` | Meaning |
| --- | --- |
| `true` | Driver confirmed the bag |
| `false` | Driver answered no |
| `NULL` | Driver dismissed the prompt — never called the endpoint |

It is a QC record, never a blocker: completion succeeds with the check outstanding.

### 3.7 Idempotent retries

```bash
KEY="retry-$(date +%s)"
curl -s -X POST http://localhost:3000/v1/driver/orders/ORDER_ID/payment \
  -H "authorization: Bearer $DRIVER" -H 'content-type: application/json' \
  -H "idempotency-key: $KEY" \
  -d '{"payment_method":"cash","amount_collected":15}' -i
```

Run it twice. The second response is byte-identical and carries `idempotent-replay: true` — the handler never ran, so nothing was written twice.

Now send the **same key with a different body** and you get **409 `IDEMPOTENCY_KEY_CONFLICT`**. Replaying the earlier response there would silently do the wrong thing.

Key order inside the JSON body is not significant — `{"a":1,"b":2}` and `{"b":2,"a":1}` fingerprint identically, so a client that serializes differently between retries still gets its replay. Keys are namespaced per driver, and a 5xx releases the reservation so a genuine retry can actually retry.

---

## 4. Checking it in the database

```sql
-- Payment fields move together; the CHECK constraint makes the alternative
-- unrepresentable
SELECT status, payment_status, payment_collected, payment_method,
       amount_due, amount_collected, cooler_bag_confirmed
FROM orders WHERE driver_id IS NOT NULL ORDER BY updated_at DESC LIMIT 5;

-- Route positions are unique per driver per day, for active stops only
SELECT driver_id, delivery_date, sequence_number, status
FROM orders WHERE sequence_number IS NOT NULL ORDER BY delivery_date, sequence_number;

-- Stored idempotent responses
SELECT idempotency_key, response_status, completed_at IS NOT NULL AS completed
FROM idempotency_keys ORDER BY created_at DESC LIMIT 5;
```

---

## 5. Not covered yet

Location ingest (`POST /v1/driver/locations`), the admin-facing WebSocket fan-out, and the real Mapbox adapter are **Phase 5**. Automatic route recalculation on pickup/completion/return also lands there — today the driver refreshes the route explicitly via `/v1/driver/queue/optimize`.

The driver-facing WebSocket channel **is** built — `order.assigned`,
`order.ready`, `order.unassigned`, `order.cancelled`. See `realtime.md` for the
contract, and `test/integration/realtime.test.ts` for coverage. To check it by
hand: connect a client to `/v1/realtime` with a driver's access token, assign
that driver an order that is already `in_pharmacy`, and confirm an
`order.assigned` frame arrives carrying only `order_id`, `delivery_date`, and
`status`.
