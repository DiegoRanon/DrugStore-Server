# Testing Phase 3 — Clients, Orders, State Machine

Covers PRD §5.1 (saved client list), §5.2 (orders and snapshotting), and §5.3 (the order state machine). Assumes the stack from [TESTING-AUTH.md](TESTING-AUTH.md) §1 is running.

---

## 1. The fast way

```bash
npm test              # 80 unit + integration tests against a real Postgres
npm run verify        # 81 black-box HTTP checks (auth + orders)
```

`npm test` creates and migrates its own `medibus_test` database, so it never touches your development data. `npm run verify:orders` runs only the Phase 3 half.

---

## 2. What the test suite covers

| File | Covers |
| --- | --- |
| `test/unit/stateMachine.test.ts` | Every legal transition, and **exhaustively** every illegal `(transition, status)` pair — 35 cases generated from the transition table, so widening the machine by accident fails the build |
| `test/unit/serializers.test.ts` | Driver PII omission on terminal orders (§8.3) |
| `test/integration/orders.test.ts` | Snapshot immutability, timestamps, status events, row locking, edit and assignment rules |
| `test/integration/orgIsolation.test.ts` | Table-driven across every authenticated route (§4.4) |

**When you add a route in a later phase, add it to the `ROUTES` table in `orgIsolation.test.ts`.** That is what makes the isolation suite catch an unscoped endpoint instead of quietly passing.

---

## 3. Manual walkthrough

Set up a token first (see [TESTING-AUTH.md](TESTING-AUTH.md) §4.2):

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@stlaurent.example.ca","password":"DevPassword123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
```

### 3.1 Create a client

```bash
curl -s -X POST http://localhost:3000/v1/clients \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "Marie Tremblay",
    "address": "1250 Rue Sainte-Catherine O, Montréal, QC H3G 1P5",
    "phone_number": "+15145550142",
    "notes": "Code de porte 4412"
  }'
```

**Expect 201.** Because `notes` has content, the response also carries `compliance_reminder` — the field is for logistics only, and §5.1 wants that surfaced in the UI rather than silently policed. A `notes` value over 500 characters is rejected with `400`.

The server logs a compliance warning on every note write, recording the length and actor but **never the content** — moving that text into the log stream is exactly what §8.6 forbids.

### 3.2 Create an order from that client

```bash
curl -s -X POST http://localhost:3000/v1/orders \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "client_id": "CLIENT_ID",
    "delivery_date": "2026-09-15",
    "delivery_window": "AM",
    "amount_due": 42.50,
    "requires_cooler_bag": true
  }'
```

**Expect 201**, with `patient_name`, `address` and `phone_number` copied from the client, `status: "in_pharmacy"`, and `payment_status: "unpaid"`.

### 3.3 The snapshot test — the one worth doing yourself

Change the client's address, then re-read the order:

```bash
curl -s -X PATCH http://localhost:3000/v1/clients/CLIENT_ID \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"address":"999 Somewhere Else"}'

curl -s http://localhost:3000/v1/orders/ORDER_ID -H "authorization: Bearer $TOKEN"
```

**The order's address must be unchanged.** A patient moving house must not rewrite where last month's delivery actually went. Create a *new* order and it will pick up `999 Somewhere Else` — the snapshot is written once, at insert, and no code path back-fills it.

### 3.4 Order detail and timeline

```bash
curl -s http://localhost:3000/v1/orders/ORDER_ID -H "authorization: Bearer $TOKEN"
```

Beyond the order fields you get:

- `status_events` — the audit trail, one row per transition including creation, each attributed to a user
- `available_transitions` — what is legal from here (`["pickup","cancel"]` at `in_pharmacy`, `[]` once terminal)

### 3.5 Edit rules

```bash
curl -s -X PATCH http://localhost:3000/v1/orders/ORDER_ID \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"delivery_window":"PM"}'
```

**Expect 200 while the order is `in_pharmacy`.** Once a driver holds the package, the same call returns **`422 ORDER_NOT_EDITABLE`** — changing the address of a delivery already in progress would mean the record no longer describes what is happening.

### 3.6 Assign a driver

```bash
curl -s -X POST http://localhost:3000/v1/orders/ORDER_ID/assign \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"driver_id":"DRIVER_ID"}'
```

Reassignment clears `sequence_number` — the previous driver's route position is meaningless to the new one. Passing `null` unassigns. A driver from another organization gives **404**; a terminal order gives **409**.

### 3.7 Cancel

```bash
curl -s -X POST http://localhost:3000/v1/orders/ORDER_ID/cancel -H "authorization: Bearer $TOKEN"
```

**Expect 200** with `status: "cancelled"` and `cancelled_at` set. Call it twice and the second returns **`409 ORDER_ALREADY_TERMINAL`**.

Cancellation only applies while the order sits at the pharmacy. Once picked up, the driver's action is a **return**, not a cancellation — §5.3 draws that line because a return means a physical package travelled and came back, and the two must not blur in reporting.

### 3.8 Filters and pagination

```bash
curl -s "http://localhost:3000/v1/orders?date=2026-09-15" -H "authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/v1/orders?status=cancelled" -H "authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/v1/orders?limit=2" -H "authorization: Bearer $TOKEN"
```

Pagination is keyset, not offset, so a page stays stable while orders are being created all day. Feed `next_cursor` back as `?cursor=`. A malformed cursor returns **`400 INVALID_CURSOR`** rather than silently returning page one.

`?updated_since=` is the polling fallback for when the WebSocket drops (§7).

### 3.9 Soft delete

```bash
curl -s -X DELETE http://localhost:3000/v1/clients/CLIENT_ID -H "authorization: Bearer $TOKEN" -i
```

**Expect 204.** Re-read the client: it still exists with `is_active: false`. Deletion is always soft — `orders.client_id` is `ON DELETE RESTRICT`, and delivery history must remain readable. Creating a new order for a deactivated client returns **`422 CLIENT_INACTIVE`**.

---

## 4. Checking the state machine in the database

```bash
docker exec -it medibus-postgres psql -U medibus -d medibus
```

```sql
-- Every terminal status carries its timestamp; the CHECK constraint makes
-- the alternative unrepresentable
SELECT status, picked_up_at, completed_at, returned_at, cancelled_at
FROM orders ORDER BY created_at DESC LIMIT 5;

-- The audit trail: one row per transition, always attributed
SELECT o.id, e.status, e.changed_by_user_id, e.occurred_at
FROM order_status_events e JOIN orders o ON o.id = e.order_id
ORDER BY e.occurred_at DESC LIMIT 10;

-- Try to corrupt it by hand — the constraint refuses
UPDATE orders SET status = 'completed' WHERE status = 'in_pharmacy';
-- ERROR: new row violates check constraint "chk_terminal_status_timestamp"
```

That last one is worth running. It is the guarantee that reporting never has to guess when a delivery closed.

---

## 5. Related

Driver-facing endpoints (`/v1/driver/queue`, pickup, complete, return, payment, cooler check) ship in Phase 4 — see [TESTING-DRIVER.md](TESTING-DRIVER.md). They drive the same state machine through the same service, so the transitions covered here are the ones the driver app performs.
