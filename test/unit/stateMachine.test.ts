import { describe, expect, it } from "vitest";

import { AppError } from "../../src/core/errors.js";
import {
  ACTIVE_STATUSES,
  assertTransitionAllowed,
  availableTransitions,
  isTerminal,
  SUCCESS_RATE_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  type OrderStatus,
  type TransitionName,
} from "../../src/modules/orders/stateMachine.js";

const ALL_STATUSES: OrderStatus[] = [
  "in_pharmacy",
  "picked_up",
  "completed",
  "returned",
  "cancelled",
];

const ALL_TRANSITIONS = Object.keys(TRANSITIONS) as TransitionName[];

const DRIVER = "driver-1";
const OTHER_DRIVER = "driver-2";

function attempt(
  transition: TransitionName,
  currentStatus: OrderStatus,
  overrides: Partial<{
    actorRole: "admin" | "driver";
    actorUserId: string;
    assignedDriverId: string | null;
  }> = {},
): AppError | null {
  try {
    assertTransitionAllowed({
      transition,
      currentStatus,
      actorRole: overrides.actorRole ?? TRANSITIONS[transition].actor,
      actorUserId: overrides.actorUserId ?? DRIVER,
      assignedDriverId:
        overrides.assignedDriverId === undefined
          ? DRIVER
          : overrides.assignedDriverId,
    });
    return null;
  } catch (error) {
    return error as AppError;
  }
}

describe("order state machine (PRD §5.3)", () => {
  describe("the legal paths", () => {
    it("allows in_pharmacy -> picked_up by the assigned driver", () => {
      expect(attempt("pickup", "in_pharmacy")).toBeNull();
    });

    it("allows picked_up -> completed", () => {
      expect(attempt("complete", "picked_up")).toBeNull();
    });

    it("allows picked_up -> returned", () => {
      expect(attempt("return", "picked_up")).toBeNull();
    });

    it("allows in_pharmacy -> cancelled by an admin", () => {
      expect(attempt("cancel", "in_pharmacy", { actorRole: "admin" })).toBeNull();
    });
  });

  describe("the illegal paths", () => {
    /**
     * Exhaustive: every (transition, status) pair not named in the table must
     * be refused. This is what stops a future edit quietly widening the
     * machine — adding a `from` without meaning to will fail here.
     */
    const legalPairs = new Set(
      ALL_TRANSITIONS.flatMap((name) =>
        TRANSITIONS[name].from.map((status) => `${name}:${status}`),
      ),
    );

    for (const transition of ALL_TRANSITIONS) {
      for (const status of ALL_STATUSES) {
        if (legalPairs.has(`${transition}:${status}`)) continue;

        it(`refuses ${transition} from ${status}`, () => {
          const error = attempt(transition, status);
          expect(error).toBeInstanceOf(AppError);
          expect(error?.statusCode).toBe(409);
          expect([
            "ORDER_INVALID_TRANSITION",
            "ORDER_ALREADY_TERMINAL",
          ]).toContain(error?.code);
        });
      }
    }

    it("cannot return an order that never left the pharmacy", () => {
      // §5.3: an order still at the pharmacy is cancelled, not returned.
      const error = attempt("return", "in_pharmacy");
      expect(error?.code).toBe("ORDER_INVALID_TRANSITION");
    });

    it("cannot cancel an order a driver already picked up", () => {
      const error = attempt("cancel", "picked_up", { actorRole: "admin" });
      expect(error?.code).toBe("ORDER_INVALID_TRANSITION");
    });

    it("reports terminal states distinctly from wrong-step errors", () => {
      for (const status of TERMINAL_STATUSES) {
        const error = attempt("complete", status);
        expect(error?.code).toBe("ORDER_ALREADY_TERMINAL");
      }
    });

    it("treats a completed order as immutable", () => {
      for (const transition of ALL_TRANSITIONS) {
        expect(attempt(transition, "completed")).toBeInstanceOf(AppError);
      }
    });
  });

  describe("actor rules", () => {
    it("refuses a driver-only transition invoked by an admin", () => {
      const error = attempt("complete", "picked_up", { actorRole: "admin" });
      expect(error?.code).toBe("FORBIDDEN");
      expect(error?.statusCode).toBe(403);
    });

    it("refuses an admin-only transition invoked by a driver", () => {
      const error = attempt("cancel", "in_pharmacy", { actorRole: "driver" });
      expect(error?.code).toBe("FORBIDDEN");
    });

    it("refuses pickup when no driver is assigned", () => {
      const error = attempt("pickup", "in_pharmacy", { assignedDriverId: null });
      expect(error?.code).toBe("ORDER_NOT_ASSIGNED");
      expect(error?.statusCode).toBe(422);
    });

    it("refuses a driver acting on another driver's order", () => {
      const error = attempt("complete", "picked_up", {
        actorUserId: OTHER_DRIVER,
        assignedDriverId: DRIVER,
      });
      expect(error?.code).toBe("ORDER_FORBIDDEN");
      expect(error?.statusCode).toBe(403);
    });
  });

  describe("invariants the rest of the system relies on", () => {
    it("pairs every transition with a timestamp column", () => {
      // The executor writes status and timestamp in one UPDATE, so a missing
      // column here would mean a terminal status with no time recorded — the
      // exact corruption chk_terminal_status_timestamp exists to catch.
      for (const name of ALL_TRANSITIONS) {
        expect(TRANSITIONS[name].timestampColumn).toBeTruthy();
      }
    });

    it("gives every terminal status its own timestamp column", () => {
      const terminalColumns = ALL_TRANSITIONS.filter((name) =>
        isTerminal(TRANSITIONS[name].to),
      ).map((name) => TRANSITIONS[name].timestampColumn);

      expect(new Set(terminalColumns).size).toBe(terminalColumns.length);
    });

    it("classifies every status as exactly one of active or terminal", () => {
      for (const status of ALL_STATUSES) {
        const active = ACTIVE_STATUSES.includes(status);
        const terminal = TERMINAL_STATUSES.includes(status);
        expect(active !== terminal).toBe(true);
      }
    });

    it("excludes cancelled orders from the success rate", () => {
      // §5.10: success rate = completed / (completed + returned). A
      // cancellation is not a failed delivery — nobody attempted it.
      expect(SUCCESS_RATE_STATUSES).toEqual(["completed", "returned"]);
      expect(SUCCESS_RATE_STATUSES).not.toContain("cancelled");
    });

    it("leaves no transition out of a terminal state", () => {
      for (const status of TERMINAL_STATUSES) {
        expect(availableTransitions(status)).toEqual([]);
      }
    });

    it("offers pickup and cancel from in_pharmacy", () => {
      expect(availableTransitions("in_pharmacy").sort()).toEqual([
        "cancel",
        "pickup",
      ]);
    });

    it("offers complete and return from picked_up", () => {
      expect(availableTransitions("picked_up").sort()).toEqual([
        "complete",
        "return",
      ]);
    });
  });
});
