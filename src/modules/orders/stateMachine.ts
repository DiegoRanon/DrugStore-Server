import type { UserRole } from "../../core/context.js";
import { AppError } from "../../core/errors.js";

/**
 * The order lifecycle from PRD §5.3.
 *
 *   in_pharmacy ──pickup──> picked_up ──complete──> completed  (terminal)
 *        │                      │
 *        │                      └──return───────────> returned   (terminal)
 *        │
 *        └──cancel──────────────────────────────────> cancelled  (terminal)
 *
 * This table is the single source of truth for what may change an order's
 * status. Every transition names its timestamp column, so the executor writes
 * status and timestamp in the same UPDATE and a transition that forgets its
 * timestamp is not expressible — `chk_terminal_status_timestamp` becomes a
 * backstop rather than the primary defence.
 */

export type OrderStatus =
  | "in_pharmacy"
  | "picked_up"
  | "completed"
  | "returned"
  | "cancelled";

export type TransitionName = "pickup" | "complete" | "return" | "cancel";

export type TimestampColumn =
  | "picked_up_at"
  | "completed_at"
  | "returned_at"
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
    description: "One-tap proof of delivery",
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
    description: "Patient unavailable; package returned to the pharmacy",
  },
  cancel: {
    from: ["in_pharmacy"],
    to: "cancelled",
    timestampColumn: "cancelled_at",
    actor: "admin",
    requiresAssignedDriver: false,
    description: "Admin cancelled a delivery that never left the pharmacy",
  },
};

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  "completed",
  "returned",
  "cancelled",
];

export const ACTIVE_STATUSES: readonly OrderStatus[] = [
  "in_pharmacy",
  "picked_up",
];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Statuses that count toward the success rate. Cancelled orders are excluded
 * from both sides of the ratio — nobody attempted a delivery, so counting them
 * as failures would understate driver performance (PRD §5.10).
 */
export const SUCCESS_RATE_STATUSES: readonly OrderStatus[] = [
  "completed",
  "returned",
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
