# Realtime channel

Source of truth for the WebSocket layer. Implementation: `src/realtime/`.

This is the driver half of PRD §7. An admin assigning an order to a driver who
already has the app open sees it appear on the driver's Ready tab in about a
second, rather than on the driver's next 30-second poll.

## What is and is not built

| | State |
| --- | --- |
| `order.assigned`, `order.ready`, `order.unassigned`, `order.cancelled` → driver | **Built** |
| `queue.resequenced` → driver | Not built |
| `order.status.changed`, `order.payment.collected` → admin (`org:{id}:orders`) | Not built — the dashboard polls `GET /v1/orders?updated_since=` |
| `driver.location.updated` → admin (`org:{id}:drivers`) | Not built — waits on location ingest |

## Connecting

| | |
| --- | --- |
| Path | `/v1/realtime` |
| Transport | `websocket` only — no XHR-polling fallback |
| Auth | The same access token as the HTTP API, in the Socket.IO handshake `auth` field |

```js
io(baseUrl, { path: '/v1/realtime', transports: ['websocket'], auth: { token } });
```

The token goes in `auth`, never in a query string: query strings land in proxy
and server access logs, and this one is a 15-minute credential to patient
addresses.

The handshake applies the same completeness check as `src/plugins/auth.ts` — a
token missing `sub`, `org_id`, or `role` is refused rather than defaulted,
because an unscoped connection is the one failure PRD §4.4 calls
non-negotiable. Refusals are indistinguishable from one another by design
(`UNAUTHENTICATED` for expired, forged, and absent alike).

**Connections are dropped when the access token expires** (PRD §7). Clients must
supply a *fresh* token on reconnect — in socket.io-client, pass `auth` as a
callback rather than an object, since it is re-invoked on every attempt.

## Rooms

`user:{userId}` — one room per user, and the only room anything is published to
today.

Not `org:{id}`: every driver at a pharmacy shares an organization, so an
org-wide room would hand one driver another driver's assignments. There is a
test for exactly that (`test/integration/realtime.test.ts`).

A Redis pub/sub adapter (`@socket.io/redis-adapter`) backs the rooms, so any API
instance can publish to a socket held by any other.

## Events

Published from `NotificationsService.emit()` — the same choke point that writes
the `driver_notifications` row, so the durable record and the live nudge cannot
disagree. Emission is post-commit and fail-open: a Redis outage costs a driver
one poll interval, it does not fail the dispatcher's assignment.

| Event | Emitted when |
| --- | --- |
| `order.assigned` | An admin assigns a driver to an order **already `in_pharmacy`** |
| `order.ready` | Staff mark an order ready that already has a driver |
| `order.unassigned` | An admin takes an `in_pharmacy` order off a driver |
| `order.cancelled` | An admin cancels an order that has a driver |

Assigning a driver to a `scheduled` order publishes **nothing**, and is not a
bug: the calendar belongs to the admin until staff declare the order ready, the
order is not in the driver's queue yet (`OrdersRepository.listQueue` filters
`scheduled` out), and a reassignment inside the calendar is dispatch
housekeeping. The driver hears about it via `order.ready`.

## Payload

Every event carries the same frame, and only this frame:

```json
{ "order_id": "uuid", "delivery_date": "2026-09-25", "status": "in_pharmacy" }
```

### The frame is a signal, not data

Every order that reaches a driver's device goes through `toDriverOrderView`, and
that serializer is the entire enforcement of the `PII_VISIBLE_STATUSES` cliff
(see `privacy-rules.md`). A frame carrying an order would be a second egress
path around it — no serializer, no status check, no audit trail.

So a frame says only *that* something changed, never *what*. The client's only
correct reaction is to refetch `GET /v1/driver/queue`, which stays the sole path
patient data takes to a phone.

**Nothing derived from a `clients` row may be added here** — not a name, not an
address, not a phone number — however convenient it would be to save the client
a round-trip. `test/integration/realtime.test.ts` asserts the exact key set, so
adding a field has to be a deliberate edit to that assertion.

## Clients must still poll

PRD §7: *"Clients must fall back to polling if the socket drops."* A frame can be
missed — a dropped connection, a Redis blip, a fail-open publish. A poll cannot.

The driver app therefore keeps its poll and only widens it while connected: 30 s
disconnected, 120 s connected (`src/queue/use-queue.ts` in
`medibus-driver-app`). It is never disabled.

## Operations

- `REALTIME_ENABLED=false` turns the layer off entirely. Clients degrade to the
  30-second poll, which is the behaviour the driver app is written to expect.
- Sockets do not pass through `@fastify/rate-limit`. The per-user budget is
  spent by the refetches frames provoke, which is why the driver app debounces
  them into one request.
- No route or schema changes, so **`openapi.json` does not describe this**. A
  WebSocket channel is not expressible in an OpenAPI document; this file is the
  contract.
