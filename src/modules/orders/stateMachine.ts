import type { UserRole } from "../../core/context.js";
import { AppError } from "../../core/errors.js";

/**
 * The order lifecycle, as the pharmacy actually works
 * (drugstore-driver-app/docs/Plans/domain_workflow.md).
 *
 *   scheduled ──mark_ready──> in_pharmacy ──pickup──> picked_up ──complete──> completed
 *       │                          │                      │                  (terminal)
 *       │                          │                      └──return──> returned
 *       │                          │                                      │
 *       │                          │                            handover──┘
 *       │                          │                                ↓
 *       │                          │                    returned_to_pharmacy (terminal)
 *       │                          │
 *       └──cancel──────────────────┴──────────────────────> cancelled (terminal)
 *
 * Two stages distinguish this from the old four-state machine:
 *
 *   "scheduled" is the admin's calendar. The order exists, staff have not yet
 *   physically prepared it, and no driver may see it. "mark_ready" is the
 *   employee declaring the bags packed and on the counter.
 *
 *   "returned" is a failed delivery whose package is still in the driver's
 *   van. It is NOT the end: the driver drives back and hands it over, and
 *   "handover" is that confirmation. Treating a return as terminal was the
 *   old model's mistake — it lost the leg where the package is in transit and
 *   nobody has signed for it.
 *
 * This table is the single source of truth for what may change an order's
 * status. Every transition names its timestamp column, so the executor writes
 * status and timestamp in the same UPDATE and a transition that forgets its
 * timestamp is not expressible — the CHECK constraints become a backstop
 * rather than the primary defence.
 */

export type OrderStatus =
  | "scheduled"
  | "in_pharmacy"
  | "picked_up"
  | "completed"
  | "returned"
  | "returned_to_pharmacy"
  | "cancelled";

export type TransitionName =
  | "mark_ready"
  | "pickup"
  | "complete"
  | "return"
  | "handover"
  | "cancel";

export type TimestampColumn =
  | "ready_at"
  | "picked_up_at"
  | "completed_at"
  | "returned_at"
  | "returned_to_pharmacy_at"
  | "cancelled_at";

export interface TransitionDefinition {
  readonly from: readonly OrderStatus[];
  readonly to: OrderStatus;
  readonly timestampColumn: TimestampColumn;
  /** Who may invoke it. */
  readonly actor: UserRole;
  /**
   * When true the order must have a driver assigned, and a driver actor must
   * be that driver.
   */
  readonly requiresAssignedDriver: boolean;
  readonly description: string;
}

export const TRANSITIONS: Record<TransitionName, TransitionDefinition> = {
  mark_ready: {
    from: ["scheduled"],
    to: "in_pharmacy",
    timestampColumn: "ready_at",
    actor: "admin",
    // Deliberately not required: staff prepare the bags whether or not
    // dispatch has picked a driver yet, and blocking the counter on an
    // assignment would invert the real sequence.
    requiresAssignedDriver: false,
    description: "Staff have prepared the order; it is ready for a driver",
  },
  pickup: {
    from: ["in_pharmacy"],
    to: "picked_up",
    timestampColumn: "picked_up_at",
    actor: "driver",
    requiresAssignedDriver: true,
    description: "Driver has taken physical custody of the package",
  },
  complete: {
    from: ["picked_up"],
    to: "completed",
    timestampColumn: "completed_at",
    actor: "driver",
    requiresAssignedDriver: true,
    description: "Delivered to an authorized recipient",
  },
  return: {
    // Only from picked_up: an order still sitting at the pharmacy is
    // cancelled, not returned. A return means a physical package travelled
    // and came back.
    from: ["picked_up"],
    to: "returned",
    timestampColumn: "returned_at",
    actor: "driver",
    requiresAssignedDriver: true,
    description: "Delivery failed; the package is in the driver's van",
  },
  handover: {
    from: ["returned"],
    to: "returned_to_pharmacy",
    timestampColumn: "returned_to_pharmacy_at",
    actor: "driver",
    requiresAssignedDriver: true,
    description: "Pharmacy staff took the undelivered package back",
  },
  cancel: {
    from: ["scheduled", "in_pharmacy"],
    to: "cancelled",
    timestampColumn: "cancelled_at",
    actor: "admin",
    requiresAssignedDriver: false,
    description: "Admin cancelled a delivery that never left the pharmacy",
  },
};

/**
 * Four status sets, each answering a different question. They overlap, but
 * they are NOT synonyms, and collapsing any two of them reintroduces a bug:
 *
 *   TERMINAL       — nothing further can happen to this order.
 *   ACTIVE         — the driver still has work to do at an address.
 *   DRIVER_CUSTODY — a physical package is in the driver's hands.
 *   PII_VISIBLE    — the driver may still see who and where.
 *
 * "returned" is the status that pulls them apart: not terminal (the handover
 * is still owed), not active (nobody is delivering it any more), in custody
 * (the package is in the van), and not PII-visible (the delivery attempt is
 * over, so the address is no longer the driver's business).
 */

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  "completed",
  "returned_to_pharmacy",
  "cancelled",
];

export const ACTIVE_STATUSES: readonly OrderStatus[] = [
  "in_pharmacy",
  "picked_up",
];

export const DRIVER_CUSTODY_STATUSES: readonly OrderStatus[] = [
  "picked_up",
  "returned",
];

/**
 * The privacy cliff (product constraint: "Drivers should only access customer
 * information while a delivery is active").
 *
 * Declared as its own list rather than derived from TERMINAL_STATUSES. It used
 * to be the expression !isTerminal(status), which was correct only by
 * coincidence — the moment "returned" stopped being terminal, that expression
 * would have started handing a patient's address and phone number back on
 * every failed delivery.
 */
export const PII_VISIBLE_STATUSES: readonly OrderStatus[] = [
  "in_pharmacy",
  "picked_up",
];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActive(status: OrderStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isInDriverCustody(status: OrderStatus): boolean {
  return DRIVER_CUSTODY_STATUSES.includes(status);
}

/** Whether a driver may still be shown the patient's name, address, and phone. */
export function showsPatientDetails(status: OrderStatus): boolean {
  return PII_VISIBLE_STATUSES.includes(status);
}

/**
 * Statuses that count toward the success rate. Cancelled orders are excluded
 * from both sides of the ratio — nobody attempted a delivery, so counting them
 * as failures would understate driver performance (PRD §5.10). A return counts
 * as an attempt whether or not the package is back on the shelf yet, so both
 * halves of the return leg are here.
 */
export const SUCCESS_RATE_STATUSES: readonly OrderStatus[] = [
  "completed",
  "returned",
  "returned_to_pharmacy",
];

export interface TransitionRequest {
  transition: TransitionName;
  currentStatus: OrderStatus;
  actorRole: UserRole;
  actorUserId: string;
  assignedDriverId: string | null;
}

/**
 * Validates a transition, throwing the documented error for each way it can
 * be refused. Pure — no database access — so the whole matrix is unit
 * testable without fixtures.
 */
export function assertTransitionAllowed(request: TransitionRequest): void {
  const definition = TRANSITIONS[request.transition];

  if (definition.actor !== request.actorRole) {
    throw new AppError(
      "FORBIDDEN",
      `Only a ${definition.actor} can ${request.transition} an order`,
    );
  }

  if (!definition.from.includes(request.currentStatus)) {
    // Terminal states get their own code: "already finished" is a different
    // problem for the caller than "wrong step in the sequence".
    if (isTerminal(request.currentStatus)) {
      throw new AppError(
        "ORDER_ALREADY_TERMINAL",
        `This order is already ${request.currentStatus} and cannot be changed`,
        { current_status: request.currentStatus },
      );
    }

    // Its own code, because it is the one refusal the caller can act on: the
    // bags are not on the counter yet, so somebody has to mark the order
    // ready. An opaque "invalid transition" would send a driver looking for a
    // bug in their app instead of an employee looking for the order.
    if (
      request.currentStatus === "scheduled" &&
      request.transition === "pickup"
    ) {
      throw new AppError(
        "ORDER_NOT_READY",
        "This order has not been declared ready by the pharmacy yet",
        { current_status: request.currentStatus },
      );
    }

    throw new AppError(
      "ORDER_INVALID_TRANSITION",
      `Cannot ${request.transition} an order that is ${request.currentStatus}`,
      {
        current_status: request.currentStatus,
        allowed_from: definition.from,
        target_status: definition.to,
      },
    );
  }

  if (definition.requiresAssignedDriver) {
    if (!request.assignedDriverId) {
      throw new AppError(
        "ORDER_NOT_ASSIGNED",
        "This order has no driver assigned",
      );
    }

    if (
      request.actorRole === "driver" &&
      request.assignedDriverId !== request.actorUserId
    ) {
      throw new AppError(
        "ORDER_FORBIDDEN",
        "This order is assigned to another driver",
      );
    }
  }
}

/** The transitions available from a status, for building client UI. */
export function availableTransitions(status: OrderStatus): TransitionName[] {
  return (Object.keys(TRANSITIONS) as TransitionName[]).filter((name) =>
    TRANSITIONS[name].from.includes(status),
  );
}
