import { describe, expect, it } from "vitest";

import {
  deliveryTimeWindow,
  resolveWindowMinutes,
  toInstant,
  type OrderTiming,
  type OrgHours,
} from "../../src/modules/orders/timeWindows.js";

/**
 * The window an order gets is what the route optimizer treats as a hard
 * promise, so the precedence between the three levels of promise, and the
 * timezone conversion under them, are both worth pinning down. A window an
 * hour out is not a slightly worse route — it is a driver told to be
 * somewhere at the wrong time.
 */

const HOURS: OrgHours = {
  timezone: "America/Toronto",
  am_window_start: "09:00",
  am_window_end: "12:00",
  pm_window_start: "13:00",
  pm_window_end: "17:00",
};

function order(overrides: Partial<OrderTiming> = {}): OrderTiming {
  return {
    delivery_date: "2026-03-10",
    delivery_window: "AM",
    requested_delivery_time: null,
    requested_time_start: null,
    requested_time_end: null,
    ...overrides,
  };
}

const minutes = (h: number, m = 0) => h * 60 + m;

describe("resolveWindowMinutes — precedence", () => {
  it("prefers an explicit range over everything else", () => {
    const window = resolveWindowMinutes(
      order({
        requested_time_start: "14:00",
        requested_time_end: "16:00",
        // Both lower levels present, and both must lose.
        requested_delivery_time: "09:30",
        delivery_window: "AM",
      }),
      HOURS,
    );

    expect(window).toEqual({ start: minutes(14), end: minutes(16) });
  });

  it("widens a single promised time into a tolerance around it", () => {
    const window = resolveWindowMinutes(
      order({ requested_delivery_time: "14:00" }),
      HOURS,
    );

    // A zero-width window is infeasible for any solver — "around 2" has to
    // become an interval or the stop can never be served.
    expect(window.end).toBeGreaterThan(window.start);
    expect(window).toEqual({ start: minutes(13, 30), end: minutes(14, 30) });
  });

  it("clamps the tolerance to the day rather than wrapping past midnight", () => {
    const early = resolveWindowMinutes(
      order({ requested_delivery_time: "00:10" }),
      HOURS,
    );
    expect(early.start).toBe(0);
    expect(early.end).toBe(minutes(0, 40));

    const late = resolveWindowMinutes(
      order({ requested_delivery_time: "23:50" }),
      HOURS,
    );
    expect(late.end).toBe(minutes(23, 59));
    expect(late.end).toBeGreaterThan(late.start);
  });

  it("falls back to the organization's AM and PM bounds", () => {
    expect(resolveWindowMinutes(order({ delivery_window: "AM" }), HOURS)).toEqual(
      { start: minutes(9), end: minutes(12) },
    );
    expect(resolveWindowMinutes(order({ delivery_window: "PM" }), HOURS)).toEqual(
      { start: minutes(13), end: minutes(17) },
    );
  });

  it("respects an organization that does not keep the default hours", () => {
    const window = resolveWindowMinutes(order({ delivery_window: "PM" }), {
      ...HOURS,
      pm_window_start: "14:30",
      pm_window_end: "20:00",
    });

    expect(window).toEqual({ start: minutes(14, 30), end: minutes(20) });
  });
});

describe("resolveWindowMinutes — the run-level override", () => {
  const override = { start: "13:00", end: "15:00" };

  it("narrows an order that only had its AM/PM window", () => {
    const window = resolveWindowMinutes(order(), HOURS, override);
    expect(window).toEqual({ start: minutes(13), end: minutes(15) });
  });

  it("never moves a stop the pharmacy already promised a time for", () => {
    // The whole reason the override sits below the two order-level promises:
    // an admin narrowing a run to the afternoon must not silently re-promise
    // a delivery that a patient was told would arrive at 09:30.
    const window = resolveWindowMinutes(
      order({ requested_delivery_time: "09:30" }),
      HOURS,
      override,
    );

    expect(window).toEqual({ start: minutes(9), end: minutes(10) });
  });

  it("never overrides an explicit range either", () => {
    const window = resolveWindowMinutes(
      order({ requested_time_start: "09:00", requested_time_end: "11:00" }),
      HOURS,
      override,
    );

    expect(window).toEqual({ start: minutes(9), end: minutes(11) });
  });
});

describe("toInstant — wall clock to absolute time", () => {
  it("uses the winter offset in winter", () => {
    // Montreal is UTC-5 in January, so 09:00 local is 14:00Z.
    expect(toInstant("2026-01-15", minutes(9), HOURS.timezone).toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
  });

  it("uses the summer offset in summer", () => {
    // ...and UTC-4 in July, so the same wall clock is 13:00Z. Assuming one
    // fixed offset would put every July route an hour out.
    expect(toInstant("2026-07-15", minutes(9), HOURS.timezone).toISOString()).toBe(
      "2026-07-15T13:00:00.000Z",
    );
  });

  it("resolves a time on the spring-forward day itself", () => {
    // DST begins 2026-03-08 in Montreal. 09:00 that morning is already EDT.
    expect(toInstant("2026-03-08", minutes(9), HOURS.timezone).toISOString()).toBe(
      "2026-03-08T13:00:00.000Z",
    );
  });

  it("handles a zone on the other side of UTC", () => {
    expect(
      toInstant("2026-03-10", minutes(9), "Europe/Paris").toISOString(),
    ).toBe("2026-03-10T08:00:00.000Z");
  });
});

describe("deliveryTimeWindow", () => {
  it("produces an ordered pair of instants", () => {
    const window = deliveryTimeWindow(
      order({ requested_time_start: "14:00", requested_time_end: "16:00" }),
      HOURS,
    );

    expect(window).toEqual({
      start: "2026-03-10T18:00:00.000Z",
      end: "2026-03-10T20:00:00.000Z",
    });
  });

  it("always returns a window, because every order has an AM/PM one", () => {
    expect(deliveryTimeWindow(order(), HOURS)).toBeDefined();
  });

  it("returns nothing rather than an impossible window", () => {
    // A malformed org-hours row would otherwise hand the solver an empty
    // interval, which makes the whole run infeasible — every stop loses its
    // ordering, not just this one. No constraint beats a broken constraint.
    const window = deliveryTimeWindow(order({ delivery_window: "AM" }), {
      ...HOURS,
      am_window_start: "12:00",
      am_window_end: "09:00",
    });

    expect(window).toBeUndefined();
  });
});
