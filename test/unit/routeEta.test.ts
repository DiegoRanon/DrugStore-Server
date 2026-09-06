import { describe, expect, it, vi } from "vitest";

import type { TravelLeg } from "../../src/integrations/traveltime/types.js";
import {
  accumulateEta,
  degradedEta,
  routableStops,
  DEPARTURE_BUFFER_SECONDS,
  DWELL_SECONDS,
  type RoutableStop,
} from "../../src/modules/orders/routeEta.js";
import { GoogleRoutesProvider } from "../../src/integrations/traveltime/googleRoutes.js";
import type { OrderRow } from "../../src/modules/orders/repository.js";

/**
 * The arithmetic a driver plans an afternoon around.
 *
 * Every failure mode here is quiet: an off-by-one dwell makes every arrival
 * five minutes wrong, a mis-indexed leg attributes the drive to the wrong
 * stop, and a zero for a missing measurement pulls the whole run earlier.
 * None of them look broken on screen.
 */

const DEPARTURE = new Date("2026-09-06T13:00:00.000Z");

function stop(id: string): RoutableStop {
  return { orderId: id, location: { latitude: 45.5, longitude: -73.5 } };
}

function leg(minutes: number, meters = 1000): TravelLeg {
  return { durationSeconds: minutes * 60, distanceMeters: meters };
}

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "order-1",
    latitude: 45.5,
    longitude: -73.5,
    ...overrides,
  } as OrderRow;
}

describe("routableStops", () => {
  it("keeps geocoded stops in the order given", () => {
    const { routable } = routableStops([
      order({ id: "a" }),
      order({ id: "b" }),
      order({ id: "c" }),
    ]);

    expect(routable.map((s) => s.orderId)).toEqual(["a", "b", "c"]);
  });

  it("sets aside a stop that was never geocoded, without dropping it", () => {
    // It stays on the driver's list; it just cannot be measured. Reporting it
    // is what lets the app say "estimate excludes 1 stop" rather than quietly
    // under-count the day.
    const { routable, unestimated } = routableStops([
      order({ id: "a" }),
      order({ id: "typed", latitude: null, longitude: null }),
      order({ id: "c" }),
    ]);

    expect(routable.map((s) => s.orderId)).toEqual(["a", "c"]);
    expect(unestimated).toEqual(["typed"]);
  });

  it("treats half a coordinate as no coordinate", () => {
    const { routable, unestimated } = routableStops([
      order({ id: "half", longitude: null }),
    ]);

    expect(routable).toHaveLength(0);
    expect(unestimated).toEqual(["half"]);
  });
});

describe("accumulateEta — the chain", () => {
  it("arrives at the first stop after the first drive, with no dwell in front", () => {
    const eta = accumulateEta({
      stops: [stop("a")],
      legs: [leg(20)],
      departure: DEPARTURE,
      origin: "pharmacy",
      unestimated: [],
    });

    // 13:00 + 20min drive. A dwell counted before the first arrival would put
    // every stop of the day five minutes late.
    expect(eta.stops[0]!.arrival_time).toBe("2026-09-06T13:20:00.000Z");
  });

  it("adds the time at each door between one arrival and the next", () => {
    const eta = accumulateEta({
      stops: [stop("a"), stop("b"), stop("c")],
      legs: [leg(10), leg(10), leg(10)],
      departure: DEPARTURE,
      origin: "pharmacy",
      unestimated: [],
    });

    // 13:10, then +5 dwell +10 drive = 13:25, then again = 13:40.
    expect(eta.stops.map((s) => s.arrival_time)).toEqual([
      "2026-09-06T13:10:00.000Z",
      "2026-09-06T13:25:00.000Z",
      "2026-09-06T13:40:00.000Z",
    ]);
  });

  it("finishes after the last handover, not on arrival at it", () => {
    const eta = accumulateEta({
      stops: [stop("a")],
      legs: [leg(20)],
      departure: DEPARTURE,
      origin: "pharmacy",
      unestimated: [],
    });

    // A driver asking "when am I done" is not asking when they pull up.
    expect(eta.finish_time).toBe("2026-09-06T13:25:00.000Z");
    expect(eta.total_duration_seconds).toBe(20 * 60 + DWELL_SECONDS);
  });

  it("attributes each drive to the stop it ends at", () => {
    const eta = accumulateEta({
      stops: [stop("a"), stop("b")],
      legs: [leg(7, 2000), leg(19, 9000)],
      departure: DEPARTURE,
      origin: "pharmacy",
      unestimated: [],
    });

    expect(eta.stops[0]).toMatchObject({
      order_id: "a",
      duration_seconds: 420,
      distance_meters: 2000,
    });
    expect(eta.stops[1]).toMatchObject({
      order_id: "b",
      duration_seconds: 1140,
      distance_meters: 9000,
    });
  });

  it("totals distance over driving only, ignoring the dwell", () => {
    const eta = accumulateEta({
      stops: [stop("a"), stop("b")],
      legs: [leg(5, 2000), leg(5, 3000)],
      departure: DEPARTURE,
      origin: "pharmacy",
      unestimated: [],
    });

    expect(eta.total_distance_meters).toBe(5000);
  });

  it("carries the unmeasurable stops through to the caller", () => {
    const eta = accumulateEta({
      stops: [stop("a")],
      legs: [leg(5)],
      departure: DEPARTURE,
      origin: "pharmacy",
      unestimated: ["typed"],
    });

    expect(eta.unestimated_order_ids).toEqual(["typed"]);
    expect(eta.degraded).toBe(false);
  });

  it("records where the chain started", () => {
    const eta = accumulateEta({
      stops: [stop("a")],
      legs: [leg(5)],
      departure: DEPARTURE,
      origin: "driver",
      unestimated: [],
    });

    expect(eta.origin).toBe("driver");
  });

  it("refuses a leg count that does not match the stops", () => {
    // The port's contract is one leg per waypoint. A short chain cannot be
    // accumulated — the gap is not necessarily at the end, and every arrival
    // after it would be wrong by an unknown amount.
    expect(() =>
      accumulateEta({
        stops: [stop("a"), stop("b")],
        legs: [leg(5)],
        departure: DEPARTURE,
        origin: "pharmacy",
        unestimated: [],
      }),
    ).toThrow(/1 legs for 2 stops/);
  });

  it("handles an empty run without inventing a finish time", () => {
    const eta = accumulateEta({
      stops: [],
      legs: [],
      departure: DEPARTURE,
      origin: "pharmacy",
      unestimated: [],
    });

    expect(eta.finish_time).toBe(eta.departure_time);
    expect(eta.total_duration_seconds).toBe(0);
  });
});

describe("degradedEta", () => {
  it("reports no stops and no total rather than a zeroed estimate", () => {
    const eta = degradedEta(DEPARTURE, "pharmacy", ["typed"]);

    expect(eta.degraded).toBe(true);
    expect(eta.stops).toEqual([]);
    // The app renders nothing on this flag. A "0 min" would read as "you are
    // finished", which is the opposite of what it means.
    expect(eta.total_duration_seconds).toBe(0);
    expect(eta.unestimated_order_ids).toEqual(["typed"]);
  });
});

describe("the departure is always in the future", () => {
  it("leaves a buffer ahead of now", () => {
    // The Routes API answers 400 INVALID_ARGUMENT for a departure that is not
    // strictly in the future, and "now" has already passed by the time the
    // request lands. This is the constant that keeps the whole estimate from
    // silently degrading to nothing.
    expect(DEPARTURE_BUFFER_SECONDS).toBeGreaterThan(0);
  });

  it("the adapter refuses to send a departure in the past", async () => {
    // The backstop for a caller that forgot the buffer. Asserted through the
    // request the adapter builds rather than a live call: a past timestamp is
    // exactly what produced "Timestamp must be set to a future time".
    const sent: { departureTime: string }[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as { departureTime: string });
        return new Response(
          JSON.stringify({ routes: [{ legs: [{ duration: "600s", distanceMeters: 1000 }] }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

    try {
      const provider = new GoogleRoutesProvider({ apiKey: "test-key" });
      await provider.legs({
        origin: { latitude: 45.5, longitude: -73.5 },
        waypoints: [{ latitude: 45.6, longitude: -73.6 }],
        // Deliberately stale.
        departureTime: new Date(Date.now() - 60_000),
        dwellSeconds: DWELL_SECONDS,
      });

      expect(Date.parse(sent[0]!.departureTime)).toBeGreaterThan(Date.now());
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
