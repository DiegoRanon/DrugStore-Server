# Delivery lifecycle

Source of truth for the order state machine. The implementation is
`src/modules/orders/stateMachine.ts`; if the two ever disagree, the code wins and
this file is the bug.

This models the pharmacy's actual process, described by the client in
`drugstore-driver-app/docs/Plans/domain_workflow.md`.

## The states

```
scheduled ──mark_ready──> in_pharmacy ──pickup──> picked_up ──complete──> completed
    │                          │                      │                  (terminal)
    │                          │                      └──return──> returned
    │                          │                                      │
    │                          │                            handover──┘
    │                          │                                ↓
    │                          │                    returned_to_pharmacy (terminal)
    │                          │
    └──cancel──────────────────┴──────────────────────> cancelled (terminal)
```

| Status                 | What is physically true                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `scheduled`            | The order is in the admin's calendar. Nobody has packed anything. **No driver can see it.** |
| `in_pharmacy`          | Staff have packed the bags and put them on the counter.                                     |
| `picked_up`            | The driver has physical custody and is en route.                                            |
| `completed`            | Delivered to an authorized recipient. Terminal.                                             |
| `returned`             | The delivery failed. **The package is in the driver's van.** Not terminal.                  |
| `returned_to_pharmacy` | Staff took the undelivered package back. Terminal.                                          |
| `cancelled`            | Called off before it ever left. Terminal.                                                   |

## The transitions

| Transition   | From                       | To                     | Timestamp                 | Actor  | Needs a driver |
| ------------ | -------------------------- | ---------------------- | ------------------------- | ------ | -------------- |
| `mark_ready` | `scheduled`                | `in_pharmacy`          | `ready_at`                | admin  | no             |
| `pickup`     | `in_pharmacy`              | `picked_up`            | `picked_up_at`            | driver | yes            |
| `complete`   | `picked_up`                | `completed`            | `completed_at`            | driver | yes            |
| `return`     | `picked_up`                | `returned`             | `returned_at`             | driver | yes            |
| `handover`   | `returned`                 | `returned_to_pharmacy` | `returned_to_pharmacy_at` | driver | yes            |
| `cancel`     | `scheduled`, `in_pharmacy` | `cancelled`            | `cancelled_at`            | admin  | no             |

`mark_ready` deliberately does **not** require an assigned driver: staff pack the
bags whether or not dispatch has picked someone, and blocking the counter on an
assignment would invert the real sequence.

## Rules the server enforces

- **Status and its timestamp are written in one UPDATE**, together with the
  `order_status_events` row, inside one transaction. `chk_terminal_status_timestamp`
  and `chk_status_stage_timestamp` are backstops, not the primary defence.
- **A row is locked (**`SELECT … FOR UPDATE`**) before its transition is validated**, so two taps on the same order serialize.
- **A** `return` **must carry a** `failure_reason`**.** Enforced in `OrdersService.transitionRow`,
  not only in the route schema, so any caller gets `422 FAILURE_REASON_REQUIRED`
  rather than a raw constraint violation.
- **A second delivery attempt is a new order**, never a reopened one. There is no
  transition out of a terminal state.
- `scheduled` **orders are invisible to drivers at the repository layer.** Every
  driver query excludes them, so a pre-assigned order 404s rather than 409s — the
  calendar is "visible uniquement par l'Admin".
- **Editing is allowed while** `scheduled` **or** `in_pharmacy` and refused after
  (`422 ORDER_NOT_EDITABLE`). Once a driver holds the bags, changing the address
  would mean the delivery being performed no longer matches its record.
- **Reassignment is allowed at any non-terminal status** and nulls `sequence_number`.
- **The route is a suggestion; priority is not.** Optimization writes
  `sequence_number`, but the queue is sorted `is_priority DESC` ahead of it, so
  a flagged stop leads regardless of what the optimizer decided. See
  "Route optimization" in `api-contracts.md`.
- **A stop with no coordinates is never dropped from a route**, only appended.
  An address Google cannot resolve is still a package in the van.

## Four status sets, and why they are not synonyms

Declared separately in `stateMachine.ts`. Collapsing any two reintroduces a bug.

| Set                       | Members                                          | Answers                             |
| ------------------------- | ------------------------------------------------ | ----------------------------------- |
| `TERMINAL_STATUSES`       | `completed`, `returned_to_pharmacy`, `cancelled` | Can anything else happen?           |
| `ACTIVE_STATUSES`         | `in_pharmacy`, `picked_up`                       | Is there work to do at an address?  |
| `DRIVER_CUSTODY_STATUSES` | `picked_up`, `returned`                          | Is a package in the driver's hands? |
| `PII_VISIBLE_STATUSES`    | `in_pharmacy`, `picked_up`                       | May the driver see who and where?   |

`returned` is what pulls them apart: **not** terminal (a handover is owed), **not**
active (nobody is delivering it), **in custody** (it is in the van), and **not**
PII-visible (the attempt is over). See [privacy-rules.md](./privacy-rules.md).

`SUCCESS_RATE_STATUSES` is `completed`, `returned`, `returned_to_pharmacy` — a
return counts as an attempt whether or not the package is back on the shelf.
Cancellations are excluded from both sides of the ratio; nobody attempted them.

## Refusal codes

| Situation                               | Code                       | HTTP |
| --------------------------------------- | -------------------------- | ---- |
| Wrong role for this transition          | `FORBIDDEN`                | 403  |
| Another driver's order                  | `ORDER_FORBIDDEN`          | 403  |
| Order already finished                  | `ORDER_ALREADY_TERMINAL`   | 409  |
| Wrong step in the sequence              | `ORDER_INVALID_TRANSITION` | 409  |
| Not packed yet (state machine's answer) | `ORDER_NOT_READY`          | 422  |
| No driver assigned                      | `ORDER_NOT_ASSIGNED`       | 422  |
| Return with no reason                   | `FAILURE_REASON_REQUIRED`  | 422  |
| Edit after pickup                       | `ORDER_NOT_EDITABLE`       | 422  |

At the HTTP edge a driver hitting a `scheduled` order gets **404**, not
`ORDER_NOT_READY` — the repository refuses before the state machine is reached.
`ORDER_NOT_READY` is the pure state machine's answer and is what a caller with
visibility of the row would see.

## Where each stage happens in the client's description

| Spec section               | Stage                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| _Avant prise en charge_    | `scheduled` → `mark_ready`, assignment, driver notification                                                               |
| _Pendant prise en charge_  | label check against `packages`, `pickup`, payment terminal decision                                                       |
| _En route_                 | manual sequencing, priority stops, mid-shift additions                                                                    |
| _À l'adresse_ — scénario A | `complete`, with payment or a `payment_exception`                                                                         |
| _À l'adresse_ — scénario B | `return` with a `failure_reason` and optional note                                                                        |
| _À l'adresse_ — scénario C | **deliberately not modelled** — the spec says these arrangements are made in person and the app carries no field for them |
| _Retour en pharmacie_      | `handover`, `return_deadline`                                                                                             |

End-of-shift cash and invoice reconciliation is **not built**. `payment_exception`
on the order is the field that will feed it.
