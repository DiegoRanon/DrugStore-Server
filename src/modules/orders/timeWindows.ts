import type { TimeWindow } from "../../integrations/routing/types.js";
import type { DeliveryWindow } from "./repository.js";

/**
 * Turns what the pharmacy promised into an interval the route optimizer can
 * treat as a constraint.
 *
 * Three levels of promise exist on an order, and they are not alternatives —
 * an order can carry all three at once. They are ranked by how specific the
 * commitment to the patient was:
 *
 *   1. requested_time_start/end  "between 2 and 4"   — an explicit range
 *   2. requested_delivery_time   "around 2"          — a single promised time
 *   3. delivery_window           "afternoon"         — the AM/PM default
 *
 * Level 2 has no width, and a zero-width window is infeasible for any solver
 * — arriving at exactly 14:00:00 is not a thing a van does. It becomes a
 * symmetric tolerance around the promised time, which is what "around 2"
 * means to the person who was told it.
 *
 * Level 3 is the floor. Every order has one, so this function always returns
 * a window, and the optimizer is never left to assume a stop can be served at
 * 3am.
 *
 * TIMEZONE
 *
 * All three levels are wall-clock times in the organization's timezone, and
 * the optimizer wants absolute instants. Converting needs the real UTC offset
 * for that specific date — Montreal is -05:00 in January and -04:00 in July,
 * and a route built on the wrong one puts every window an hour out. The
 * offset is resolved through Intl rather than assumed, so DST is handled by
 * the same database the rest of the system trusts for it.
 */

/** Tolerance either side of a single promised time. */
const REQUESTED_TIME_TOLERANCE_MINUTES = 30;

export interface OrgHours {
  timezone: string;
  am_window_start: string;
  am_window_end: string;
  pm_window_start: string;
  pm_window_end: string;
}

export interface OrderTiming {
  delivery_date: string;
  delivery_window: DeliveryWindow;
  requested_delivery_time: string | null;
  requested_time_start: string | null;
  requested_time_end: string | null;
}

/** A run-level range from the dashboard, narrowing a whole optimization. */
export interface TimeRangeOverride {
  start: string;
  end: string;
}

/** "HH:MM" or "HH:MM:SS" → minutes since midnight. */
function toMinutes(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function clampToDay(minutes: number): number {
  return Math.max(0, Math.min(24 * 60 - 1, minutes));
}

/**
 * The UTC offset, in minutes, in force at a given instant in a zone.
 *
 * Derived by formatting the instant in the target zone and reading the parts
 * back as if they were UTC: the difference between that and the original
 * instant is the offset. Uses only Intl, so there is no timezone dependency
 * to keep updated.
 */
function offsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  // Intl renders midnight as hour 24 rather than 0 in some engines.
  const hour = read("hour") % 24;

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );

  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * A wall-clock time on a calendar date in a zone, as an absolute instant.
 *
 * The offset is looked up twice: once against a first guess, then again
 * against the instant that guess produced. One correction is enough for every
 * real zone — the guess is only ever wrong by the DST shift itself, and the
 * second lookup lands inside the correct offset.
 */
export function toInstant(
  date: string,
  minutesIntoDay: number,
  timezone: string,
): Date {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day, 0, minutesIntoDay);

  const firstGuess = new Date(naive - offsetMinutes(new Date(naive), timezone) * 60_000);
  const corrected = naive - offsetMinutes(firstGuess, timezone) * 60_000;

  return new Date(corrected);
}

/**
 * Resolves an order's delivery window to wall-clock minutes, before any
 * timezone conversion. Split out so the precedence rules can be tested
 * without a date or a zone.
 */
export function resolveWindowMinutes(
  order: OrderTiming,
  hours: OrgHours,
  override?: TimeRangeOverride,
): { start: number; end: number } {
  if (order.requested_time_start && order.requested_time_end) {
    return {
      start: toMinutes(order.requested_time_start),
      end: toMinutes(order.requested_time_end),
    };
  }

  if (order.requested_delivery_time) {
    const centre = toMinutes(order.requested_delivery_time);
    return {
      start: clampToDay(centre - REQUESTED_TIME_TOLERANCE_MINUTES),
      end: clampToDay(centre + REQUESTED_TIME_TOLERANCE_MINUTES),
    };
  }

  // The run-level range from the dashboard applies only here, to orders with
  // no promise of their own. An admin narrowing a run to "this afternoon"
  // must not quietly move a stop the pharmacy promised for 10am.
  if (override) {
    return { start: toMinutes(override.start), end: toMinutes(override.end) };
  }

  return order.delivery_window === "AM"
    ? {
        start: toMinutes(hours.am_window_start),
        end: toMinutes(hours.am_window_end),
      }
    : {
        start: toMinutes(hours.pm_window_start),
        end: toMinutes(hours.pm_window_end),
      };
}

/**
 * The absolute interval to send the optimizer for one order.
 *
 * Returns undefined only when the resolved window is empty or inverted, which
 * a CHECK constraint prevents for stored ranges but not for a malformed
 * org-hours row. An absent window is a stop with no timing constraint, which
 * is strictly better than an impossible one that makes the whole solve
 * infeasible.
 */
export function deliveryTimeWindow(
  order: OrderTiming,
  hours: OrgHours,
  override?: TimeRangeOverride,
): TimeWindow | undefined {
  const { start, end } = resolveWindowMinutes(order, hours, override);
  if (!(start < end)) return undefined;

  return {
    start: toInstant(order.delivery_date, start, hours.timezone).toISOString(),
    end: toInstant(order.delivery_date, end, hours.timezone).toISOString(),
  };
}
