import type { GeoPoint } from "../routing/types.js";
import type {
  TravelLegsRequest,
  TravelLegsResult,
  TravelTimeProvider,
} from "./types.js";

/**
 * Credential-free travel time for development and tests.
 *
 * Derives each leg from the straight-line distance between the two points at
 * a fixed city speed. That is not a route — it ignores every one-way street
 * in Montreal — but it is deterministic, ordered sensibly, and roughly the
 * right magnitude, which is what a test asserting "the third stop is later
 * than the second" needs.
 *
 * It reports `degraded: false` because it genuinely measured something
 * (unlike `FakeOptimizer.estimate`, which returns nulls). The numbers are
 * honest about being a fake by being a fake: nothing here claims traffic.
 */

/** Rough urban average, metres per second — about 25 km/h door to door. */
const CITY_SPEED_MPS = 7;

/** Straight lines underestimate; real streets bend. */
const DETOUR_FACTOR = 1.35;

const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)));
}

export class FakeTravelTimeProvider implements TravelTimeProvider {
  readonly name = "fake";

  async legs(request: TravelLegsRequest): Promise<TravelLegsResult> {
    let from = request.origin;

    const legs = request.waypoints.map((to) => {
      const distanceMeters = Math.round(haversineMeters(from, to) * DETOUR_FACTOR);
      from = to;
      return {
        distanceMeters,
        // At least a minute: no two addresses are zero seconds apart, and a
        // zero would make an arrival time land on the one before it.
        durationSeconds: Math.max(60, Math.round(distanceMeters / CITY_SPEED_MPS)),
      };
    });

    return { legs, degraded: false, provider: this.name };
  }
}

/**
 * Always fails. Proves the ETA degrades to "no estimate" rather than to a
 * wrong one — a driver plans their afternoon around this number.
 */
export class FailingTravelTimeProvider implements TravelTimeProvider {
  readonly name = "failing";

  async legs(): Promise<TravelLegsResult> {
    throw new Error("travel time provider unavailable");
  }
}
