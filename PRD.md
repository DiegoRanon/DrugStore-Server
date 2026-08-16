# PRD — Centralized Server (Node.js)

**Product:** Drugstore Delivery App B2B
**Component:** Backend API + real-time services
**Status:** Development Planning
**Version:** 0.2 (MVP) — `returned` order status added to the schema

---

## 1. Purpose & Scope

The centralized server is the single source of truth for the platform. It owns all persistence, authorization, business rules, and third-party integrations. The React admin dashboard and the React Native driver app are thin clients: they hold no business logic and never talk to Mapbox, Twilio, or PostgreSQL directly.

### In scope

- REST API for the Admin Panel and Driver Panel
- Authentication, role-based access control, and organization-level data isolation
- Order lifecycle and state machine enforcement
- Route optimization via Mapbox (server-brokered)
- Automated client notifications via Twilio (server-brokered)
- Driver geolocation ingestion and real-time fan-out to admins
- Logistical reporting and delivery-service invoice generation
- PII protection controls required by Law 25 and PIPEDA

### Out of scope (MVP)

- Any medical, pharmaceutical, or prescription data (MVP §4)
- Digital payment processing — the server records _that_ payment was collected via physical POS, never card data (MVP §5)
- Pharmacy software integrations (PrescribeIT, Kroll, etc.)
- Patient-facing accounts or logins; patients are notification recipients only
- Multi-org drivers (a driver belongs to exactly one organization)

---

## 2. Architecture & Stack

| Layer      | Choice                            | Notes                                                      |
| ---------- | --------------------------------- | ---------------------------------------------------------- |
| Runtime    | Node.js 20 LTS                    | TypeScript, ESM                                            |
| Framework  | Express or Fastify                | Fastify preferred for schema-based validation + throughput |
| Database   | PostgreSQL 15+                    | Per `drugstore_delivery_schema.sql`                        |
| DB access  | Prisma or Knex + migrations       | Migrations version-controlled, forward-only                |
| Real-time  | WebSocket (Socket.IO or `ws`)     | Driver location fan-out to admin dashboard                 |
| Jobs/queue | BullMQ + Redis                    | Notification sends, invoice generation, retention purges   |
| Validation | Zod / JSON Schema                 | Every request body and query string validated at the edge  |
| Hosting    | AWS Canada Central (ca-central-1) | Data residency requirement — no cross-region replication   |
| Secrets    | AWS Secrets Manager               | No credentials in env files or source                      |

### Deployment topology

- API service (stateless, horizontally scalable behind ALB)
- WebSocket service (sticky sessions or Redis adapter for multi-instance)
- Worker service (queue consumers; no public ingress)
- RDS PostgreSQL (Multi-AZ), ElastiCache Redis
- All traffic TLS 1.2+; RDS encryption at rest via KMS

---

## 3. API Conventions

- Base path: `/v1`. Breaking changes ship under a new version prefix.
- JSON only (`application/json`), UTF-8, timestamps in ISO 8601 UTC.
- Auth: `Authorization: Bearer <access_token>`.
- Errors use a stable envelope:
  ```json
  {
    "error": {
      "code": "ORDER_INVALID_TRANSITION",
      "message": "…",
      "details": {}
    }
  }
  ```
- Codes: `400` validation, `401` unauthenticated, `403` unauthorized/out-of-org, `404` not found, `409` state conflict, `422` business-rule violation, `429` rate limited, `5xx` server.
- List endpoints paginate with `?limit=` (default 50, max 200) and `?cursor=`.
- Mutating endpoints on the driver app accept an `Idempotency-Key` header — the driver app operates on flaky mobile networks and will retry.
- Every response carries `X-Request-Id` for support and log correlation.

---

## 4. Authentication & Access Control

### 4.1 Roles

Two roles only (`user_role` enum): `admin` and `driver`. One admin per organization is enforced at the DB layer by the partial unique index; the API must surface a clear `409 ORG_ADMIN_EXISTS` rather than a raw constraint error.

### 4.2 Login

Unified login endpoint — the server determines role from the user record and returns it in the token and response body so the client can route to the correct interface (MVP §3).

- Passwords hashed with Argon2id (or bcrypt cost ≥ 12).
- Access token: JWT, 15 min TTL, claims `{ sub, role, org_id }`.
- Refresh token: opaque, 30 days, stored hashed server-side, rotated on use, revocable.
- Failed-login throttling: 5 attempts per email per 15 min, then exponential backoff.
- `users.is_active = FALSE` blocks login and invalidates active refresh tokens.

### 4.3 Driver onboarding via invite code (MVP §3)

1. Admin generates a code → row in `invite_codes` (org-scoped, optional `expires_at`).
2. Driver registers with the code + their details.
3. Server validates: code exists, `is_active`, not expired, not already redeemed. On success creates the `users` row with `role = 'driver'` and `organization_id` from the code, then stamps `redeemed_by_user_id` and `redeemed_at`.
4. Redemption is a single transaction; a code is single-use.

### 4.4 Organization isolation (non-negotiable)

Every authenticated request resolves an `organization_id` from the token. **All queries are filtered by it at the data-access layer, not per-route.** Implement as a mandatory scope in the repository layer so a forgotten `WHERE` clause is impossible. Drivers are further restricted to rows where `orders.driver_id = :self`.

### 4.5 Endpoints

| Method | Path                       | Role   | Purpose                    |
| ------ | -------------------------- | ------ | -------------------------- |
| POST   | `/v1/auth/login`           | public | Unified admin/driver login |
| POST   | `/v1/auth/refresh`         | public | Rotate refresh token       |
| POST   | `/v1/auth/logout`          | any    | Revoke refresh token       |
| POST   | `/v1/auth/register/driver` | public | Register with invite code  |
| GET    | `/v1/auth/me`              | any    | Current user + org context |
| POST   | `/v1/auth/password/change` | any    | Change own password        |

---

## 5. Functional Requirements

### 5.1 Clients (saved patient list)

Admins maintain a reusable list per organization so staff pick from a saved record instead of re-typing address and phone for every delivery.

| Method | Path                             | Role                                      |
| ------ | -------------------------------- | ----------------------------------------- |
| GET    | `/v1/clients?search=&is_active=` | admin                                     |
| POST   | `/v1/clients`                    | admin                                     |
| GET    | `/v1/clients/:id`                | admin                                     |
| PATCH  | `/v1/clients/:id`                | admin                                     |
| DELETE | `/v1/clients/:id`                | admin (soft-delete → `is_active = FALSE`) |

- Deletion is always soft; `orders.client_id` is `ON DELETE RESTRICT`, so hard deletes must be rejected with a clear message.
- **`clients.notes` guardrail:** the field exists for logistics only ("buzz code 4412", "leave with concierge"). The server must not become a shadow medical record (MVP §4). Ship a hard 500-char limit, strip nothing automatically, but log a compliance warning and surface an in-UI reminder. Consider a keyword heuristic in Phase 2.

### 5.2 Orders

The core entity. Created by admins with **logistical data only**: patient name, address, phone, delivery date, delivery window, payment status (MVP §4).

**Snapshotting:** on create, `patient_name` / `address` / `phone_number` are pre-filled from the `clients` row and stored on the order. They are editable per order. Later edits to the client record must never rewrite historical deliveries — the server writes the snapshot at insert time and never back-fills.

| Method | Path                                             | Role  | Purpose                              |
| ------ | ------------------------------------------------ | ----- | ------------------------------------ |
| POST   | `/v1/orders`                                     | admin | Create (optionally from `client_id`) |
| GET    | `/v1/orders?date=&status=&driver_id=&client_id=` | admin | Logistical history view              |
| GET    | `/v1/orders/:id`                                 | admin | Detail + status event timeline       |
| PATCH  | `/v1/orders/:id`                                 | admin | Edit while `in_pharmacy` only        |
| POST   | `/v1/orders/:id/assign`                          | admin | Assign/reassign driver               |
| POST   | `/v1/orders/:id/cancel`                          | admin | Cancel while `in_pharmacy`           |

### 5.3 Order state machine

```
in_pharmacy ──pickup──> picked_up ──complete──> completed  (terminal)
                            │
                            └──return───────────> returned   (terminal)
```

Rules the server enforces:

- Transitions are validated server-side; invalid transitions return `409 ORDER_INVALID_TRANSITION`.
- `picked_up` requires an assigned driver and is only callable by that driver. Sets `picked_up_at`.
- `completed` is the one-tap Proof of Delivery (MVP §5). Sets `completed_at`.
- `returned` is the "Return Order" action for an unavailable patient (MVP §5). Sets `returned_at`, closes the delivery, and triggers a route recalculation that sends the driver back to the pharmacy with the physical package.
- `returned` is reachable **only** from `picked_up` — an order still sitting at the pharmacy is cancelled, not returned.
- Status and its timestamp are written in the same `UPDATE`. The DB enforces this via `chk_terminal_status_timestamp`, so a transition that forgets the timestamp fails loudly instead of corrupting reports.
- A second delivery attempt is a **new order**, not a reopened one. This keeps `order_status_events` readable as one attempt per order and keeps success-rate maths honest.
- A returned order still carries its payment state: if the driver never reached the patient, nothing was collected, and the order stays `unpaid`.
- Every transition writes a row to `order_status_events` with `changed_by_user_id` in the **same transaction** as the order update. This table feeds all reporting and is the audit trail.
- Terminal states (`completed`, `returned`) are immutable; corrections require an admin-only override that writes a new event rather than mutating history.

### 5.4 Driver queue & route optimization (MVP §5)

| Method | Path                                 | Role   | Purpose                                     |
| ------ | ------------------------------------ | ------ | ------------------------------------------- |
| GET    | `/v1/driver/queue?date=`             | driver | Active orders, ordered by `sequence_number` |
| POST   | `/v1/driver/queue/optimize`          | driver | Recalculate optimal order                   |
| POST   | `/v1/driver/orders/:id/pickup`       | driver | → `picked_up`                               |
| POST   | `/v1/driver/orders/:id/complete`     | driver | One-tap PoD → `completed`                   |
| POST   | `/v1/driver/orders/:id/return`       | driver | → `returned`                                |
| POST   | `/v1/driver/orders/:id/payment`      | driver | Record collection                           |
| POST   | `/v1/driver/orders/:id/cooler-check` | driver | Post-delivery QC                            |
| POST   | `/v1/driver/locations`               | driver | Batched location pings                      |

Route optimization:

- Server calls the **Mapbox Optimization API** with the driver's current position plus all non-terminal stops, then writes the resulting order into `orders.sequence_number`.
- Triggered on: pickup of a new batch, completion or return of a stop, admin reassignment, or explicit driver refresh.
- `sequence_number` is transient working state, not a historical record.
- Mapbox failure must not block the driver: fall back to the previous sequence (or creation order) and return a `degraded: true` flag rather than an error.
- Mapbox tokens live server-side only. The mobile client receives the ordered stop list and, if needed, a short-lived scoped token for map rendering.

### 5.5 Payments (MVP §5)

No digital payment processing. If the admin flags an order `unpaid`, the driver collects at the door on a physical POS and taps a checkbox.

`POST /v1/driver/orders/:id/payment` accepts `{ payment_method, amount_collected }` and sets `payment_collected = TRUE`, `payment_collected_at = now()`, `payment_status = 'paid'`. The DB check constraint requires method and amount whenever `payment_collected` is true — the API validates this before insert and returns a field-level error, never a raw constraint failure.

**Source of truth:** `payment_status` is the business state (what the pharmacy is owed); `payment_collected` is the driver's action. The server owns keeping them consistent; clients never write `payment_status` directly except at order creation.

### 5.6 Quality control (MVP §5)

`cooler_bag_confirmed` is prompted only when `requires_cooler_bag = TRUE`, immediately after a completion or return. It is a QC record, not a blocker — a driver can dismiss it, leaving the column `NULL`, and unconfirmed cooler bags surface in the admin report.

### 5.7 One-tap calling (MVP §5)

No server telephony. The queue payload includes the client's `phone_number` and the organization's `phone` so the app can invoke the native dialer. The client phone must be omitted once the order reaches a terminal state (§8.3).

### 5.8 Driver tracking (MVP §6)

- Ingest: `POST /v1/driver/locations` accepts a **batch** of `{latitude, longitude, recorded_at}` points so the app can buffer offline and flush on reconnect. Target cadence ~15s while a delivery is active; no collection when the driver is off-shift.
- Storage: append to `driver_locations`.
- Fan-out: on ingest, publish to the WebSocket channel `org:{organization_id}:drivers`. Admin dashboards subscribe after JWT handshake and receive only their own organization's drivers.
- Read API: `GET /v1/drivers/:id/location` (latest) and `GET /v1/drivers/:id/track?from=&to=` (history for a shift).
- Rate limit ingest to 10 req/min per driver to bound cost and table growth.

### 5.9 Notifications (MVP §7)

The end client receives an SMS or email with their scheduled AM/PM window.

- Trigger: order creation (and re-send on window/date change). Enqueued, never sent inline with the HTTP request.
- Channel: `sms` if a phone is present, otherwise `email`.
- Flow: insert `notifications` row as `queued` → worker calls Twilio → update to `sent` (with timestamp) or `failed`.
- Retries: 3 attempts with exponential backoff; permanent Twilio failures (invalid number) do not retry.
- Message templates are server-side, bilingual **FR/EN**, and contain no medical content — patient first name, pharmacy name, date, and AM/PM window only.
- Admin endpoints: `GET /v1/orders/:id/notifications`, `POST /v1/orders/:id/notifications/resend`.
- Twilio status callbacks land on a signature-verified webhook: `POST /v1/webhooks/twilio/status`.

### 5.10 Reporting (MVP §6)

Computed from `order_status_events`, not from the mutable `orders` row.

| Method | Path                               | Returns                                                 |
| ------ | ---------------------------------- | ------------------------------------------------------- |
| GET    | `/v1/reports/summary?from=&to=`    | Volume, success rate, return rate, avg time-to-delivery |
| GET    | `/v1/reports/drivers?from=&to=`    | Per-driver deliveries, avg pickup→complete duration     |
| GET    | `/v1/reports/exceptions?from=&to=` | Returns, unpaid-on-completion, unconfirmed cooler bags  |
| GET    | `/v1/reports/export?…`             | CSV export (audit-logged — see §8.4)                    |

Definitions to lock before build: _delivery time_ = `picked_up_at → completed_at`; _success rate_ = completed ÷ (completed + returned).

### 5.11 Billing & invoicing (MVP §6)

Automatic invoice generation for **delivery services rendered** — the platform billing the pharmacy, unrelated to what the patient owes.

- Monthly job aggregates each organization's terminal-state orders in the period and applies the org's per-delivery rate.
- `GET /v1/invoices`, `GET /v1/invoices/:id`, `GET /v1/invoices/:id/pdf`, `POST /v1/invoices/generate` (admin/internal).
- Invoice line items reference order IDs only — never patient names or addresses.
- **Requires new tables and a pricing field; see §9.1.**

---

## 6. Third-Party Integrations

| Service                          | Used for                       | Failure policy                                    |
| -------------------------------- | ------------------------------ | ------------------------------------------------- |
| Mapbox Optimization / Directions | Route sequencing, ETAs         | Degrade gracefully, keep prior sequence, alert    |
| Twilio Programmable Messaging    | Client SMS/email notifications | Queue + retry ×3, mark `failed`, surface to admin |

Both are called **only** from the server. All calls carry timeouts (5s), circuit breakers, and structured logging of latency and error rates. Third-party outages must never block a driver from completing a delivery.

---

## 7. Real-Time Layer

- WebSocket authenticated with the same access token during handshake; connection dropped on expiry.
- Rooms: `org:{id}:drivers` (locations), `org:{id}:orders` (status changes).
- Events pushed to admins: `driver.location.updated`, `order.status.changed`, `order.payment.collected`.
- Events pushed to drivers: `order.assigned`, `order.unassigned`, `queue.resequenced`.
- Redis pub/sub adapter so any API instance can publish to any connected socket.
- Clients must fall back to polling `GET /v1/orders?updated_since=` if the socket drops.

---

## 8. Privacy & Security (MVP §8)

### 8.1 Compliance posture

Law 25 (Quebec) and PIPEDA. All personal information stays in `ca-central-1` — no cross-region backups, no third-party processor outside Canada without a documented assessment. Twilio and Mapbox usage must be covered in the org's privacy policy and, for Law 25, a PIA (_évaluation des facteurs relatifs à la vie privée_) should be on file before launch.

### 8.2 Encryption

- In transit: TLS 1.2+ everywhere, HSTS, no plaintext internal hops.
- At rest: KMS-backed RDS and EBS encryption; automated backups encrypted with the same CMK.
- **Decision required (§9.2):** application-level column encryption for PII conflicts with `idx_clients_name` and any search/sort on those columns. Recommended MVP position: rely on KMS volume/RDS encryption plus strict access control, and treat column-level encryption as a Phase 2 item with a blind-index design.

### 8.3 Data minimization on the driver device

Once an order reaches `completed` or `returned`, the API **stops returning** `patient_name`, `address`, and `phone_number` to the driver. The row persists server-side for admin history and reporting. Implementation:

- Separate response serializers for driver vs admin contexts.
- `GET /v1/driver/queue` returns only non-terminal orders with PII; terminal orders return an ID, timestamp, and status only.
- The driver app must purge its local cache on transition — server-side enforcement is what makes this real, since a client-only wipe is not a control.

### 8.4 Audit logging

Law 25 accountability requires knowing who accessed personal information. `order_status_events` covers status changes only. The server must additionally log — outside the operational DB, to CloudWatch or a dedicated append-only table — every PII **read** by an admin (order detail views, client list exports, report CSV downloads) with actor, timestamp, IP, and record scope.

### 8.5 Retention

- `driver_locations`: purge after 90 days (justify the period; it is behavioural employee data).
- Refresh tokens: purge on expiry.
- Orders and clients: define a retention period with the client's legal counsel, then run a scheduled anonymization job that nulls PII columns on orders past that window while preserving aggregate reporting fields.
- Right to erasure: `DELETE /v1/clients/:id/pii` (admin, audit-logged) anonymizes a patient's identifying fields across their client record and historical orders.

### 8.6 General hardening

Helmet security headers, strict CORS allow-list, global rate limiting (100 req/min per user), request body size caps, parameterized queries only, dependency scanning in CI, and no PII in application logs or error-tracking payloads (Sentry scrubbing configured before first deploy).

---

## 9. Schema Gaps & Required Changes

The provided schema covers most of the MVP cleanly. These items block or weaken requirements and should be resolved before implementation starts.

### 9.1 Blocking

| #   | Gap                                        | Impact                                                                    | Proposed change                                                                                                                                                     |
| --- | ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~`order_status` has no `returned` value~~ | —                                                                         | **✅ Resolved in schema v1.1** — enum value, `returned_at`, and `chk_terminal_status_timestamp` added. Deployed instances apply `001_add_returned_order_status.sql` |
| 2   | No invoicing tables                        | MVP §6 automatic invoice generation has nowhere to persist                | Add `invoices` and `invoice_line_items`; add `delivery_rate` to `organizations`                                                                                     |
| 3   | No amount owed on the order                | Driver sees no amount to collect; `amount_collected` cannot be reconciled | Add `amount_due NUMERIC(10,2)` to `orders`                                                                                                                          |
| 4   | No refresh-token/session storage           | Cannot revoke a compromised session or a deactivated driver's access      | Add `refresh_tokens` (user_id, token_hash, expires_at, revoked_at)                                                                                                  |
| 5   | No PII-access audit trail                  | Law 25 accountability gap (§8.4)                                          | Append-only `access_audit_log`, or CloudWatch sink                                                                                                                  |

### 9.2 Recommended

| #   | Gap                                                  | Proposed change                                                                               |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 6   | Column-level PII encryption vs `idx_clients_name`    | Decide encryption strategy before writing the data layer (§8.2)                               |
| 7   | `driver_locations` grows unbounded                   | Monthly partitioning + 90-day purge job                                                       |
| 8   | `driver_locations` has no `organization_id`          | Denormalize for tracking queries, or accept the join to `users`                               |
| 9   | Duplicate `sequence_number` possible per driver/date | Partial unique index on `(driver_id, delivery_date, sequence_number)` for non-terminal orders |
| 10  | `notifications` lacks provider metadata              | Add `provider_message_id`, `error_code`, `attempt_count` for Twilio callbacks and retries     |
| 11  | AM/PM windows undefined                              | Store cutoff hours in org settings so notification copy and reporting agree                   |
| 12  | No delivery-fee history                              | Rate changes would retroactively alter past invoices; snapshot the rate onto the invoice line |

---

## 10. Non-Functional Requirements

| Requirement                                | Target                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| API latency (p95, read)                    | < 300 ms                                                                                                  |
| Location ingest latency to admin dashboard | < 2 s end to end                                                                                          |
| Availability                               | 99.5% during pharmacy hours (07:00–21:00 ET)                                                              |
| Concurrent drivers per org                 | 25 (MVP), 200 platform-wide                                                                               |
| Recovery point objective                   | 24 h (daily automated RDS snapshot, 7-day retention)                                                      |
| Observability                              | Structured JSON logs, request IDs, Sentry, CloudWatch alarms on 5xx rate and queue depth                  |
| Test coverage                              | Unit + integration on the order state machine, org isolation, and driver PII serializers (non-negotiable) |

---

## 11. Suggested Build Sequence

1. **Foundation** — migrations, config, auth, org scoping, error envelope, CI.
2. **Core logistics** — clients CRUD, orders CRUD, state machine, status events.
3. **Driver flow** — queue, pickup/complete/return, payment recording, cooler check, PII serializers.
4. **Real-time & routing** — location ingest, WebSocket fan-out, Mapbox optimization.
5. **Communications** — queue infrastructure, Twilio worker, templates, webhook.
6. **Reporting & billing** — report endpoints, invoice tables and generation job.
7. **Compliance hardening** — audit logging, retention jobs, erasure endpoint, PIA support.

---

## 12. Open Questions

1. Who is billed, and at what rate — flat per delivery, or tiered by volume/zone?
2. Can one driver serve multiple pharmacies? The current schema says no (single `organization_id` on `users`); confirm this holds for launch.
3. Is a returned order re-deliverable as a new order, or reopened? Recommendation: always create a new order to keep history clean.
4. Retention period for completed orders — driven by the pharmacy's own obligations; needs legal input.
5. Should notifications also fire on pickup ("your delivery is on the way")? Not in MVP §7, but it is the most common competitor feature and cheap to add.
6. Do admins need to reassign a driver mid-route, and should the original driver's device wipe that order's PII immediately? Recommendation: yes to both.
