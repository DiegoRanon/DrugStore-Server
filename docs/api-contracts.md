# API contracts

`openapi.json` is the authoritative schema — it is generated from the same Zod
schemas Fastify validates against (`npm run openapi:dump`), so it cannot drift.
This file covers what the spec cannot express: what changed, and what a client
has to do differently.

**39 operations across 6 route groups.** Base path `/v1`. Errors are always
`{ "error": { "code", "message", "details" } }`.

---

## Breaking changes — workflow alignment

Both client repos need work. In rough order of "nothing works until you do this":

### 1. `POST /v1/orders` now creates a `scheduled` order

An order is born in the admin calendar, not on the counter. **Until somebody calls
`POST /v1/orders/{id}/ready`, no driver will ever see it.**

The dashboard must add that step. Without it, orders are created and nothing
happens — the most likely way to ship a broken build against this change.

Render it from `available_transitions`, which now includes `mark_ready`, rather
than hardcoding it.

### 2. `returned` is no longer terminal

A failed delivery goes `picked_up → returned → returned_to_pharmacy`. The middle
state means "the package is in the driver's van".

The driver app's Done tab has to split into **"to hand back"** and **"done"**.
`PRD-DRIVER-APP.md` §5.1 says "No separate Returning tab … there is no tracked
return leg" — **that is now wrong**, and the tab is required.

`GET /v1/driver/queue` gives you the buckets directly: `stops`, `to_return`,
`closed`.

### 3. `POST /v1/driver/orders/{id}/return` requires a body

```json
{ "reason": "customer_absent", "note": "optional, driver's discretion" }
```

`reason` ∈ `customer_absent`, `customer_refused`, `wrong_address`,
`payment_refused`, `other`. A bodyless call is now `400 VALIDATION_FAILED`.

### 4. `available_transitions` has two new values

`mark_ready` and `handover`. Dashboards and apps that render buttons from this
array pick both up for free; anything switching on a closed set of strings needs
updating.

### 5. A driver hitting a `scheduled` order gets 404

Not 409. The row is excluded at the repository layer, so it is indistinguishable
from one that does not exist. Do not special-case a "not ready" message on the
client — you will never see it.

---

## New endpoints

### Admin

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/orders/{id}/ready` | Staff declare the order physically packed. Notifies the assigned driver. |
| `POST /v1/orders/{id}/priority` | Flag or unflag a priority stop. |
| `GET /v1/orders/calendar?from=&to=` | Per-day counts by status. Counts only, no PII, not audit-logged. |
| `POST /v1/orders/route/optimize` | `{ date, driver_id, time_range? }` — sequence one driver's day. See "Route optimization" below. |
| `GET /v1/places/autocomplete?q=&session_token=` | Address suggestions. Admin only. |
| `GET /v1/places/{place_id}?session_token=` | Resolve a suggestion to a standardized address and coordinates. Admin only. |

`GET /v1/orders` also accepts `from`, `to`, and `is_priority`.

### Driver

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/driver/queue/sequence` | `{ date?, ordered_order_ids }` — the driver's own route order. |
| `POST /v1/driver/orders/{id}/handover` | Confirm the pharmacy took one package back. |
| `POST /v1/driver/returns/handover` | `{ order_ids }` — the whole stack at once. All or nothing. |
| `POST /v1/driver/orders/{id}/priority` | The employee flagged this stop verbally at pickup. |
| `POST /v1/driver/queue/eta` | `{ date?, current_location? }` — traffic-aware arrival times for the rest of the run. Writes nothing. See "Arrival times" below. |
| `GET /v1/driver/notifications?unread=` | The in-app feed. |
| `POST /v1/driver/notifications/read` | `{ ids? }` — omit to mark everything read. |

---

## Route optimization

Two entry points write the same thing — `orders.sequence_number` for one
driver on one date — and share one implementation
(`modules/orders/routeService.ts`):

| Caller | Endpoint | Whose day |
| --- | --- | --- |
| Driver app | `POST /v1/driver/queue/optimize` | Their own, from the token |
| Dashboard | `POST /v1/orders/route/optimize` | Any driver in the org, from `driver_id` |

Whichever ran last wins, which is the intent: the later actor knows more.

### Addresses become coordinates once, at order creation

`POST /v1/orders` and `PATCH /v1/orders/{id}` now accept `place_id`,
`formatted_address`, `latitude`, and `longitude`, captured by the dashboard
from Places autocomplete. They are snapshotted onto the order the same way
`address` always has been, and are never re-resolved afterwards — editing a
patient's address does not move a delivery that already happened.

Coordinates are optional throughout. A hand-typed address still saves; it
simply cannot be routed, so it is **appended** to the sequence rather than
placed in it, and its id comes back in `unroutable_order_ids`. Nothing is ever
dropped for want of a coordinate — an unroutable stop is still a package in
the van.

### Time windows

A stop's window is resolved from the most specific promise available:

1. `requested_time_start` + `requested_time_end` — an explicit range
2. `requested_delivery_time` — a single promised time, widened to ±30 minutes
3. the organization's `AM`/`PM` window bounds

The optional `time_range` on the admin endpoint is a **run-level default**,
not an override: it applies only to stops carrying no promise of their own. An
admin narrowing a run to the afternoon must not silently re-promise a delivery
a patient was told would arrive at 09:30.

All three levels are wall-clock times in `organizations.timezone` and are
converted to absolute instants against the delivery date, so a route built in
March and one built in July get the right UTC offset.

### Priority still outranks the route

`is_priority` is passed to the provider (as a higher skip penalty, so an
urgent stop is never the one a constrained solve gives up on), but the queue
is sorted `is_priority DESC, sequence_number ASC NULLS LAST` in SQL *after*
optimization. A flagged stop goes first even when that costs kilometres. This
is a product decision, not an oversight.

### Arrival times

`POST /v1/driver/queue/eta` measures the chain the queue is **already in** —
pharmacy to the first stop, then stop to stop — and returns a predicted
arrival for each plus a finish time for the whole run.

It is a read that costs money, and it writes nothing. The stop order is an
input, never an output: a driver checking their ETA must not risk being handed
a re-sequenced route they are halfway through driving.

| | Optimize | ETA |
| --- | --- | --- |
| Question | "what order?" | "how long?" |
| Google product | Route Optimization API | Routes API |
| Credential | service account | `GOOGLE_MAPS_API_KEY` |
| Env | `ROUTE_OPTIMIZER` | `TRAVEL_TIME` |
| Writes `sequence_number` | yes | **no** |
| Called | when someone presses optimize | on the screen, and after every delivery or return |

Because the ETA runs on the plain Maps key, a pharmacy that cannot create a
service-account key still gets working arrival times without working
optimization.

**Traffic** comes from `routingPreference: TRAFFIC_AWARE` plus a departure
time. Long runs are split across chained calls (the Routes API caps a request
at 25 intermediate waypoints) with each chunk departing at the previous
chunk's predicted arrival — so the afternoon half of a long day is priced as
afternoon traffic.

**`finish_time` includes time at the door.** A flat five-minute allowance per
stop, matching the visit duration the optimizer already assumes. A driver
asking when they are done is not asking when they last arrive, and an estimate
built from drive time alone tells someone with twelve stops they will be
finished an hour early.

**Degradation**, as everywhere else here: a provider outage returns
`degraded: true` with no stops and a zero total, and the app renders nothing.
It is never an error, and never an invented number — a driver plans an
afternoon around this. Stops that were never geocoded come back in
`unestimated_order_ids` rather than being silently missing, so the app can say
the estimate covers less than the list.

### Providers

Selected by `ROUTE_OPTIMIZER`, `GEOCODER`, and `TRAVEL_TIME`. All default to `fake`, which
needs no credentials and is what tests and dev run on — `vitest.config.ts`
pins them so a developer holding real keys cannot have the suite bill their
account. `googlemaps` selects, respectively: Google Route Optimization (a Cloud
API — service account, not the Maps key), Places API (New), and the Routes API.
The last two share the plain `GOOGLE_MAPS_API_KEY`.

---

## Realtime (WebSocket)

Not an HTTP endpoint and therefore **not in `openapi.json`** — see
[realtime.md](realtime.md), which is the contract.

Socket.IO at `/v1/realtime`, authenticated with the same access token in the
handshake. Drivers are pushed `order.assigned`, `order.ready`,
`order.unassigned`, and `order.cancelled` — the same four moments that write a
`driver_notifications` row, published from the same place.

Two things a client must get right:

- **The frame carries no patient data**, only
  `{ order_id, delivery_date, status }`. React to it by refetching
  `GET /v1/driver/queue`; never render it.
- **Keep polling.** The socket is an accelerator, not a replacement. PRD §7
  requires the fallback, and the driver app only widens its interval (30 s →
  120 s) while connected.

There is no admin fan-out yet; the dashboard still polls
`GET /v1/orders?updated_since=`.

---

## Changed payloads

### `POST /v1/orders` / `PATCH /v1/orders/{id}` accept

```jsonc
{
  "requested_delivery_time": "14:30",        // finer than the AM/PM window
  "authorized_recipient": "Concierge, apt 4B",
  "is_priority": false,
  "packages": [                               // label codes, for the pickup check
    { "label_code": "4412-A" },
    { "label_code": "4412-B", "package_type": "cooler" }
  ]
}
```

`package_type` ∈ `bag`, `cooler`, `tote`, `envelope`. There is **no description
field** — see [privacy-rules.md](./privacy-rules.md) §3.

A `cooler` package forces `requires_cooler_bag` to `true`; the two cannot drift.
`PATCH` replaces the package list wholesale, and is allowed while `scheduled` or
`in_pharmacy`.

### `POST /v1/driver/orders/{id}/complete` accepts an optional body

```jsonc
// money changed hands
{ "payment": { "payment_method": "cash", "amount_collected": 42.50 } }

// or the pharmacy authorised handing it over anyway
{ "payment_exception": "waived_by_pharmacy", "payment_exception_note": "..." }
```

Both at once is `400`. The transition and the collection are written in **one
transaction** — a retry with an `Idempotency-Key` replays both or neither.

`POST /v1/driver/orders/{id}/payment` is unchanged and still there, for the case
where the terminal only went through after the delivery was marked complete.

### `POST /v1/driver/orders/{id}/pickup` accepts an optional body

```json
{ "confirmed_package_count": 2 }
```

The digital trace of the label check. A count that disagrees with the order is
**accepted and logged**, not refused — the physical bags on the counter are the
truth, and a driver standing there with an employee must not be blocked.

### `GET /v1/driver/queue` response

```jsonc
{
  "date": "2026-09-20",
  "pharmacy": { "name": "…", "phone": "…", "return_deadline": "18:00:00" },
  "stops":     [ /* active, with patient details */ ],
  "to_return": [ /* failed, in the van, NO patient details */ ],
  "closed":    [ /* terminal, NO patient details */ ],
  "totals": {
    "stop_count": 3,
    "priority_count": 1,
    "payment_stop_count": 2,
    "amount_due_total": 67.50,
    "requires_payment_terminal": true,   // take the POS from the pharmacy
    "packages_to_return": 2
  },
  "estimates": [ /* omitted entirely when the optimizer cannot measure */ ],
  "unread_notifications": 1,
  "has_new": false,
  "last_updated_at": "2026-09-20T14:02:11.000Z"
}
```

Poll with `?updated_since=<last_updated_at>` to get `has_new`. This is how a
driver learns about an order the pharmacy added mid-shift; there is no push.

An active stop gains `is_priority`, `requested_delivery_time`,
`authorized_recipient`, `packages`, `package_count`. Priority stops sort to the
front of `stops` regardless of route position.

### `degraded` still means only one thing (unchanged)

The route is the driver's previous one, not the optimizer's answer. It is **not**
set when estimates are unavailable — an adapter that can order but not measure
has given a perfectly good route. Missing estimates say so by `estimates` being
absent. With the current `FakeOptimizer`, it always is.

---

## Non-breaking additions to `orderResponse`

`authorized_recipient`, `requested_delivery_time`, `is_priority`,
`payment_exception`, `payment_exception_note`, `failure_reason`, `failure_note`,
`packages`, `package_count`, `pickup_package_count`, `ready_at`,
`returned_to_pharmacy_at`.

`failure_note` and `payment_exception_note` are admin-only and never appear in a
driver response.

---

## New error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `ORDER_NOT_READY` | 422 | The bags are not packed yet. Not reachable over HTTP by a driver — see breaking change 5. |
| `FAILURE_REASON_REQUIRED` | 422 | A `return` arrived without a reason. |

---

## Regenerating

```
npm run openapi:dump      # after any route or schema change
```

The dashboard runs `openapi-typescript` against `openapi.json`. Request bodies
that are optional use `z.preprocess` rather than `.nullish()` specifically so the
generated types stay usable — a nullish body renders as
`anyOf: [{not: {}}, {...}]`.
