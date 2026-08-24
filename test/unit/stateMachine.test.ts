import { describe, expect, it } from "vitest";

import { AppError } from "../../src/core/errors.js";
import {
  ACTIVE_STATUSES,
  assertTransitionAllowed,
  availableTransitions,
  DRIVER_CUSTODY_STATUSES,
  isTerminal,
  PII_VISIBLE_STATUSES,
  showsPatientDetails,
  SUCCESS_RATE_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  type OrderStatus,
  type TransitionName,
} from "../../src/modules/orders/stateMachine.js";

const ALL_STATUSES: OrderStatus[] = [
  "scheduled",
  "in_pharmacy",
  "picked_up",
  "completed",
  "returned",
  "returned_to_pharmacy",
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

describe("order state machine", () => {
  describe("the legal paths", () => {
    it("allows scheduled -> in_pharmacy when staff declare it ready", () => {
      expect(
        attempt("mark_ready", "scheduled", { actorRole: "admin" }),
      ).toBeNull();
    });

    it("allows in_pharmacy -> picked_up by the assigned driver", () => {
      expect(attempt("pickup", "in_pharmacy")).toBeNull();
    });

    it("allows picked_up -> completed", () => {
      expect(attempt("complete", "picked_up")).toBeNull();
    });

    it("allows picked_up -> returned", () => {
      expect(attempt("return", "picked_up")).toBeNull();
    });

    it("allows returned -> returned_to_pharmacy when staff take it back", () => {
      expect(attempt("handover", "returned")).toBeNull();
    });

    it("allows cancelling from both pharmacy-side statuses", () => {
      expect(attempt("cancel", "scheduled", { actorRole: "admin" })).toBeNull();
      expect(
        attempt("cancel", "in_pharmacy", { actorRole: "admin" }),
      ).toBeNull();
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
          expect([
            "ORDER_INVALID_TRANSITION",
            "ORDER_ALREADY_TERMINAL",
            "ORDER_NOT_READY",
          ]).toContain(error?.code);
        });
      }
    }

    it("tells a driver an unprepared order is not ready, not that it is broken", () => {
      // The one refusal somebody can act on: the bags are not packed yet, so
      // an employee has to mark it ready. A generic invalid-transition would
      // send the driver hunting for a bug in their app instead.
      const error = attempt("pickup", "scheduled");
      expect(error?.code).toBe("ORDER_NOT_READY");
      expect(error?.statusCode).toBe(422);
    });

    it("cannot return an order that never left the pharmacy", () => {
      // An order still at the pharmacy is cancelled, not returned.
      const error = attempt("return", "in_pharmacy");
      expect(error?.code).toBe("ORDER_INVALID_TRANSITION");
    });

    it("cannot cancel an order a driver already picked up", () => {
      const error = attempt("cancel", "picked_up", { actorRole: "admin" });
      expect(error?.code).toBe("ORDER_INVALID_TRANSITION");
    });

    it("cannot hand over a package that never failed a delivery", () => {
      expect(attempt("handover", "picked_up")?.code).toBe(
        "ORDER_INVALID_TRANSITION",
      );
      expect(attempt("handover", "completed")?.code).toBe(
        "ORDER_ALREADY_TERMINAL",
      );
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

    it("treats a handed-back order as immutable", () => {
      for (const transition of ALL_TRANSITIONS) {
        expect(
          attempt(transition, "returned_to_pharmacy"),
        ).toBeInstanceOf(AppError);
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

    it("refuses a driver marking an order ready", () => {
      // The pharmacy declares its own counter ready, not the person collecting
      // from it.
      const error = attempt("mark_ready", "scheduled", { actorRole: "driver" });
      expect(error?.code).toBe("FORBIDDEN");
    });

    it("lets staff mark an order ready before anyone is assigned", () => {
      // Bags get packed whether or not dispatch has picked a driver; requiring
      // an assignment first would invert the real sequence.
      expect(
        attempt("mark_ready", "scheduled", {
          actorRole: "admin",
          assignedDriverId: null,
        }),
      ).toBeNull();
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

    it("refuses a driver handing back another driver's package", () => {
      const error = attempt("handover", "returned", {
        actorUserId: OTHER_DRIVER,
        assignedDriverId: DRIVER,
      });
      expect(error?.code).toBe("ORDER_FORBIDDEN");
    });
  });

  describe("invariants the rest of the system relies on", () => {
    it("pairs every transition with a timestamp column", () => {
      // The executor writes status and timestamp in one UPDATE, so a missing
      // column here would mean a status with no time recorded — the exact
      // corruption the CHECK constraints exist to catch.
      for (const name of ALL_TRANSITIONS) {
        expect(TRANSITIONS[name].timestampColumn).toBeTruthy();
      }
    });

    it("gives every transition its own timestamp column", () => {
      const columns = ALL_TRANSITIONS.map(
        (name) => TRANSITIONS[name].timestampColumn,
      );
      expect(new Set(columns).size).toBe(columns.length);
    });

    /**
     * The load-bearing one.
     *
     * The driver serializer used to decide whether to include a patient's name,
     * address, and phone by asking !isTerminal(status). That was correct only
     * while "returned" happened to be terminal. It no longer is — the package
     * rides back to the pharmacy first — so if anyone re-derives the privacy
     * cliff from the terminal set, every failed delivery starts handing a
     * patient's address back to the driver.
     */
    it("keeps the privacy cliff independent of the terminal set", () => {
      expect(showsPatientDetails("returned")).toBe(false);
      expect(isTerminal("returned")).toBe(false);

      // Stated as a whole-set equality rather than a spot check, so widening
      // PII_VISIBLE_STATUSES has to be a deliberate edit to this line.
      expect([...PII_VISIBLE_STATUSES].sort()).toEqual([
        "in_pharmacy",
        "picked_up",
      ]);

      for (const status of ALL_STATUSES) {
        if (showsPatientDetails(status)) {
          expect(isTerminal(status)).toBe(false);
        }
      }
    });

    it("never shows patient details on a status the driver cannot act at", () => {
      // scheduled is admin-only; everything past the attempt is over.
      expect(showsPatientDetails("scheduled")).toBe(false);
      expect(showsPatientDetails("completed")).toBe(false);
      expect(showsPatientDetails("returned_to_pharmacy")).toBe(false);
      expect(showsPatientDetails("cancelled")).toBe(false);
    });

    it("keeps custody and activity distinct", () => {
      // A returned package is in the driver's van but nobody is delivering it.
      expect(DRIVER_CUSTODY_STATUSES).toContain("returned");
      expect(ACTIVE_STATUSES).not.toContain("returned");
      // And an order on the counter is active but not yet in anyone's hands.
      expect(ACTIVE_STATUSES).toContain("in_pharmacy");
      expect(DRIVER_CUSTODY_STATUSES).not.toContain("in_pharmacy");
    });

    it("classifies no status as both active and terminal", () => {
      for (const status of ALL_STATUSES) {
        const active = ACTIVE_STATUSES.includes(status);
        const terminal = TERMINAL_STATUSES.includes(status);
        expect(active && terminal).toBe(false);
      }
    });

    it("gives every status either a way forward or terminal status", () => {
      for (const status of ALL_STATUSES) {
        const hasMoves = availableTransitions(status).length > 0;
        expect(hasMoves || isTerminal(status)).toBe(true);
      }
    });

    it("excludes cancelled orders from the success rate", () => {
      // Success rate = completed / (completed + returned). A cancellation is
      // not a failed delivery — nobody attempted it. Both halves of the return
      // leg count as an attempt, whether or not the package is back yet.
      expect([...SUCCESS_RATE_STATUSES].sort()).toEqual([
        "completed",
        "returned",
        "returned_to_pharmacy",
      ]);
      expect(SUCCESS_RATE_STATUSES).not.toContain("cancelled");
      expect(SUCCESS_RATE_STATUSES).not.toContain("scheduled");
    });

    it("leaves no transition out of a terminal state", () => {
      for (const status of TERMINAL_STATUSES) {
        expect(availableTransitions(status)).toEqual([]);
      }
    });

    it("offers mark_ready and cancel from scheduled", () => {
      expect(availableTransitions("scheduled").sort()).toEqual([
        "cancel",
        "mark_ready",
      ]);
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

    it("offers only the handover from returned", () => {
      expect(availableTransitions("returned")).toEqual(["handover"]);
    });
  });
});
