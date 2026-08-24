# Privacy rules

The product constraints this file implements (from the platform `CLAUDE.md`):

> - Do not store prescription or medical information.
> - Store only necessary delivery information.
> - Drivers should only access customer information while a delivery is active.
> - Delivery completion and return flows must enforce privacy requirements.

## 1. The privacy cliff is not the terminal set

This is the single most important thing in this file, and the easiest to break.

The driver serializer decides whether to include `patient_name`, `address`,
`phone_number`, and `authorized_recipient` by asking
`showsPatientDetails(status)` — **never** `!isTerminal(status)`.

Those two expressions used to agree. They no longer do:

```
PII_VISIBLE_STATUSES = [in_pharmacy, picked_up]
TERMINAL_STATUSES    = [completed, returned_to_pharmacy, cancelled]
```

`returned` is in neither. A failed delivery is **not terminal** — the driver still
owes the pharmacy a handover — but the delivery attempt is over, so the patient's
details go immediately. Anyone who re-derives the cliff from the terminal set
starts handing a patient's address and phone number back on **every failed
delivery**.

`test/unit/serializers.test.ts` has a case named
*"omits patient details on a failed delivery awaiting handover"* whose only job is
to fail if this regresses, and `test/unit/stateMachine.test.ts` asserts the two
sets are computed independently.

## 2. The control is structural, not procedural

`toDriverOrderView` returns a discriminated union. The closed branch **does not
read the PII columns at all**:

```ts
export type DriverOrderView = ActiveDriverOrderView | ClosedDriverOrderView;
```

`ClosedDriverOrderView` has no `patient_name` field to populate. Because every
driver route is typed to return `DriverOrderView`, leaking PII on a closed
delivery is a **compile error**, not something a reviewer has to catch. A
client-side cache wipe is not enforcement; this is.

## 3. No medical data, by shape

`order_packages` carries `label_code` (what is printed on the bag) and
`package_type` (a closed enum: `bag`, `cooler`, `tote`, `envelope`). It has **no
description, notes, or free-text column**, and the request schema strips unknown
keys.

That absence is the control. A free-text line item is exactly where a medication
name would end up, and a policy saying "please don't" is not a mechanism.
`test/integration/packages.test.ts` asserts the persisted column list.

The only free-text fields anywhere near an order are:

| Field | Guard |
| --- | --- |
| `clients.notes` | 500-char cap, `compliance_reminder` returned in the response |
| `orders.failure_note` | Driver's words about a failed delivery — **admin only**, never returned to a driver, redacted from logs |
| `orders.payment_exception_note` | Admin only |

## 4. Fields that are PII and where they may appear

| Field | Admin | Driver (active) | Driver (closed) | Logs |
| --- | --- | --- | --- | --- |
| `patient_name` | yes | yes | **no** | redacted |
| `address` | yes | yes | **no** | redacted |
| `phone_number` | yes | yes | **no** | redacted |
| `authorized_recipient` | yes | yes | **no** | redacted |
| `failure_note` | yes | **no** | **no** | redacted |
| `label_code` | yes | yes | yes | not redacted — a bag number is not a person |

Label codes stay on a closed stop deliberately: the driver has to hand the right
parcels back at the counter.

Log redaction is configured once, on the logger, in `src/app.ts` — so a future
`request.log.info({ order })` cannot leak an address by accident.

## 5. Org and driver scoping

Enforced at the data-access layer, not per route (`src/core/repository.ts`):

- `OrgScopedRepository.scoped()` is the only query entry point subclasses get and
  always applies the organization predicate.
- `OrdersRepository.actorScoped()` adds `driver_id = self` for driver callers,
  **and** excludes `scheduled` orders entirely — the admin calendar is
  "visible uniquement par l'Admin".
- Out-of-scope rows answer **404**, identical to a row that does not exist. A
  distinguishable 403 would confirm the id is real.

`test/integration/orgIsolation.test.ts` drives a table of every authenticated
route. **Adding a route without adding it to that table is the failure mode that
test exists to prevent.**

## 6. Audit logging

`auditPiiRead()` writes to the append-only `access_audit_log` for four actions:
`order.list.read`, `order.detail.read`, `client.list.read`, `client.detail.read`.

Deliberately **not** audited:

- **Driver reads.** A driver polling their own queue every 15s would bury the
  trail in operational noise.
- **`GET /v1/orders/calendar`.** It returns integers per day. Recording it as a
  PII read would bury the real accesses every time someone pages a month.

Audit writes are fail-open: a failure logs at `error` with
`compliance: "audit_write_failed"` rather than 500-ing the request.

## 7. What is not built

Named here so nobody assumes otherwise: there is no retention purge job, no
`DELETE /v1/clients/:id/pii` right-to-erasure endpoint, and no driver location
tracking (the `driver_locations` table exists but nothing writes to it).
`ORDER_RETENTION_DAYS` and `DRIVER_LOCATION_RETENTION_DAYS` are config values with
no consumer.
