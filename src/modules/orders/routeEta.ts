import type { GeoPoint } from "../../integrations/routing/types.js";
import type { TravelLeg } from "../../integrations/traveltime/types.js";
import type { OrderRow } from "./repository.js";

/**
 * Turns a chain of measured drives into the clock times a driver reads.
 *
 * THE CHAIN
 *
 *   pharmacy ──drive──▶ stop 1 ──dwell──▶ ──drive──▶ stop 2 ──dwell──▶ …
 *
 * Arrival at the first stop is departure plus the first drive. Every arrival
 * after that is the previous arrival, plus the time spent at that door, plus
 * the next drive. The run is finished when the driver walks away from the
 * last one — so the total includes the final dwell, because a driver asking
 * "when am I done" is not asking when they arrive somewhere.
 *
 * WHY DWELL IS COUNTED AND NOT MEASURED
 *
 * Nobody measures how long a handover takes, and it varies from thirty
 * seconds to five minutes depending on whether anyone answers the door. A
 * flat allowance is a guess, but it is a guess in the right direction: an ETA
 * built from drive time alone tells a driver with twelve stops that they will
 * be finished an hour before they will be, which is worse than being roughly
 * right. It matches the visit duration the route optimizer already assumes.
 *
 * ORDER IS TAKEN, NEVER CHOSEN
 *
 * This module reads a sequence and reports on it. It has no opinion about
 * what the sequence should be — that was settled by the optimizer and the
 * pharmacy's priority flags, and re-deciding it here would put the driver's
 * screen out of step with the pharmacist's (PRD §3.1).
 */

/** Time at the door: park, walk up, hand over, get a signature. */
export const DWELL_SECONDS = 300;

/**
 * How far ahead of "now" the run is measured from.
 *
 * The Routes API rejects a departure time that is not strictly in the future
 * — `400 INVALID_ARGUMENT: Timestamp must be set to a future time` — and
 * "now", by the time the request has crossed the network, is not. A minute is
 * comfortably past any plausible latency or clock skew, and is honest besides:
 * a driver reading this is still standing there, not already moving.
 *
 * The same instant is handed to the provider and to the accumulator, so the
 * arrival times are computed from exactly the base Google measured against.
 */
export const DEPARTURE_BUFFER_SECONDS = 60;

/** A stop that can be measured, because it has somewhere to measure to. */
export interface RoutableStop {
  orderId: string;
  location: GeoPoint;
}

export interface EtaStopView {
  order_id: string;
  /** Drive from the previous point on the chain to this stop. */
  duration_seconds: number;
  distance_meters: number;
  /** When the driver is predicted to pull up, ISO 8601. */
  arrival_time: string;
}

export interface RouteEtaView {
  /** When the chain is measured from, ISO 8601. */
  departure_time: string;
  /** Where it starts: the pharmacy, or the driver if they sent a fix. */
  origin: "pharmacy" | "driver";
  stops: EtaStopView[];
  /** Driving plus dwell, start to walking away from the last door. */
  total_duration_seconds: number;
  /** Driving only — what the odometer sees. */
  total_distance_meters: number;
  /** When the whole run is predicted to be finished, ISO 8601. */
  finish_time: string;
  /**
   * Stops left out because they were never geocoded. They are still on the
   * driver's list; they simply cannot be measured, and are reported so the
   * app can say "estimate excludes 2 stops" rather than quietly under-count.
   */
  unestimated_order_ids: string[];
  /**
   * True when no estimate could be produced at all. The app shows nothing
   * rather than a number — a driver plans their afternoon around this.
   */
  degraded: boolean;
}

/**
 * The stops that can take part in a chain, in the order given.
 *
 * A stop with no coordinate is not an error and not a gap: it stays on the
 * driver's screen and simply sits outside the estimate.
 */
export function routableStops(orders: OrderRow[]): {
  routable: RoutableStop[];
  unestimated: string[];
} {
  const routable: RoutableStop[] = [];
  const unestimated: string[] = [];

  for (const order of orders) {
    if (order.latitude !== null && order.longitude !== null) {
      routable.push({
        orderId: order.id,
        location: { latitude: order.latitude, longitude: order.longitude },
      });
    } else {
      unestimated.push(order.id);
    }
  }

  return { routable, unestimated };
}

/**
 * Folds measured legs into arrival times.
 *
 * `legs[i]` is the drive into `stops[i]`, which is the contract the travel
 * time port promises. A mismatch in length means the provider answered a
 * different question than the one asked, and is the caller's cue to degrade.
 */
export function accumulateEta(input: {
  stops: RoutableStop[];
  legs: TravelLeg[];
  departure: Date;
  origin: "pharmacy" | "driver";
  unestimated: string[];
  dwellSeconds?: number;
}): RouteEtaView {
  const dwell = input.dwellSeconds ?? DWELL_SECONDS;

  if (input.legs.length !== input.stops.length) {
    throw new Error(
      `eta chain: ${input.legs.length} legs for ${input.stops.length} stops`,
    );
  }

  let clock = input.departure.getTime();
  let distance = 0;

  const stops = input.stops.map((stop, index) => {
    const leg = input.legs[index]!;

    // Drive, then arrive. The dwell that follows belongs to the *next* hop,
    // which is why it is added after the arrival is recorded rather than
    // before — otherwise every arrival would be five minutes too late.
    clock += leg.durationSeconds * 1000;
    distance += leg.distanceMeters;

    const view: EtaStopView = {
      order_id: stop.orderId,
      duration_seconds: leg.durationSeconds,
      distance_meters: leg.distanceMeters,
      arrival_time: new Date(clock).toISOString(),
    };

    clock += dwell * 1000;
    return view;
  });

  // `clock` now sits after the last dwell, which is exactly when the driver
  // is finished — the last package is in someone's hands.
  const finish = new Date(clock);

  return {
    departure_time: input.departure.toISOString(),
    origin: input.origin,
    stops,
    total_duration_seconds: Math.round(
      (finish.getTime() - input.departure.getTime()) / 1000,
    ),
    total_distance_meters: distance,
    finish_time: finish.toISOString(),
    unestimated_order_ids: input.unestimated,
    degraded: false,
  };
}

/** The shape returned when nothing could be measured. */
export function degradedEta(
  departure: Date,
  origin: "pharmacy" | "driver",
  unestimated: string[],
): RouteEtaView {
  return {
    departure_time: departure.toISOString(),
    origin,
    stops: [],
    total_duration_seconds: 0,
    total_distance_meters: 0,
    finish_time: departure.toISOString(),
    unestimated_order_ids: unestimated,
    degraded: true,
  };
}
