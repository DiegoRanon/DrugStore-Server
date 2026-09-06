import type { GeoPoint } from "../routing/types.js";

/**
 * Traffic-aware travel time port (Route Optimizer, ETA).
 *
 * WHY THIS IS NOT THE ROUTE OPTIMIZER PORT
 *
 * They answer different questions with different Google products and different
 * credentials, on different schedules:
 *
 *   RouteOptimizer   "what order?"   Route Optimization API, service account,
 *                                    called once when someone presses optimize
 *   TravelTimeProvider "how long?"   Routes API, plain Maps key, called again
 *                                    every time the driver finishes a stop
 *
 * Collapsing them would mean a driver marking a delivery done re-runs a
 * tour solve — expensive, slow, and capable of silently reordering a route
 * they are halfway through driving. The order is decided once; the clock is
 * re-read constantly.
 *
 * THE ORDER IS AN INPUT, NEVER AN OUTPUT
 *
 * An implementation must measure the chain exactly as given. Google's Routes
 * API can reorder waypoints for you and must not be allowed to here: the
 * sequence already encodes the optimizer's answer *and* the pharmacy's
 * priority flags, and a provider quietly improving on it would put the
 * driver's screen out of step with the pharmacist's (PRD §3.1).
 */

export interface TravelLegsRequest {
  /** Where the run starts — the pharmacy, or the driver if they sent a fix. */
  origin: GeoPoint;
  /** Every stop, in the exact order they will be visited. */
  waypoints: GeoPoint[];
  /**
   * When the driver sets off. Traffic is *predicted* for this instant, so a
   * route measured at 08:00 for an 16:30 departure is a rush-hour answer, not
   * a quiet-morning one.
   */
  departureTime: Date;
  /**
   * How long the driver spends at each stop before setting off again. Used to
   * keep the predicted departure honest across a long run: leg twelve is
   * driven an hour after leg one, and pricing its traffic as if it were not
   * is where a whole-day estimate drifts.
   */
  dwellSeconds: number;
}

export interface TravelLeg {
  durationSeconds: number;
  distanceMeters: number;
}

export interface TravelLegsResult {
  /**
   * One leg per waypoint, in the same order: `legs[i]` is the drive *into*
   * `waypoints[i]`. `legs[0]` is therefore the pharmacy to the first stop.
   *
   * Either every leg is present or the result is degraded. A partial chain
   * cannot be accumulated into arrival times, and a gap in the middle would
   * silently shorten every ETA after it.
   */
  legs: TravelLeg[];
  /** True when the provider could not measure and the legs are not real. */
  degraded: boolean;
  provider: string;
}

export interface TravelTimeProvider {
  readonly name: string;
  legs(request: TravelLegsRequest): Promise<TravelLegsResult>;
}
