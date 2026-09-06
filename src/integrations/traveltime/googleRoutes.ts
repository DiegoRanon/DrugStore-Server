import { fetchJson } from "../http.js";
import type { GeoPoint } from "../routing/types.js";
import type {
  TravelLeg,
  TravelLegsRequest,
  TravelLegsResult,
  TravelTimeProvider,
} from "./types.js";

/**
 * Google Routes API adapter (`computeRoutes`).
 *
 * Runs on the plain Maps API key — the same one Places uses — not the service
 * account the Route Optimization API needs. That is worth knowing: a pharmacy
 * that cannot create a service-account key (org policy, commonly) still gets
 * working ETAs.
 *
 * TRAFFIC
 *
 * `routingPreference: TRAFFIC_AWARE` plus a `departureTime` is what makes the
 * returned duration a prediction rather than a free-flow estimate. The
 * departure time matters as much as the preference: the same chain measured
 * for 08:00 and for 16:30 are different numbers, and a driver leaving at
 * four wants the second one.
 *
 * TRAFFIC_AWARE rather than TRAFFIC_AWARE_OPTIMAL: the optimal mode is
 * materially slower and costs more per call, and this is called again every
 * time a driver marks a stop delivered. The accuracy difference does not
 * survive the five-minute dwell assumption sitting on top of it.
 *
 * WAYPOINT ORDER IS PRESERVED
 *
 * `optimizeWaypointOrder` is left off deliberately. The sequence handed in is
 * already the optimizer's answer with the pharmacy's priority flags applied
 * on top; letting Google improve on it here would reorder a route the driver
 * is halfway through.
 */

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/**
 * Routes API caps a single call at 25 intermediate waypoints, so one call
 * covers an origin plus 25 intermediates plus a destination. Longer runs are
 * split into chained calls — see `legs()`.
 */
const MAX_INTERMEDIATES = 25;
const MAX_WAYPOINTS_PER_CALL = MAX_INTERMEDIATES + 1;

/** Generous: this is a chain of drives, and the driver is looking at a spinner. */
const HTTP_TIMEOUT_MS = 15_000;

/**
 * Floor for how far ahead of now a departure may be.
 *
 * The API answers `400 INVALID_ARGUMENT: Timestamp must be set to a future
 * time` for anything else, and a departure of exactly "now" is already in the
 * past by the time the request lands. Callers are expected to have applied
 * their own buffer (see DEPARTURE_BUFFER_SECONDS); this is the backstop that
 * keeps a caller who forgot from losing the whole estimate to a 400.
 */
const MIN_DEPARTURE_LEAD_MS = 30_000;

const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.legs.duration",
  "routes.legs.distanceMeters",
].join(",");

interface ComputeRoutesResponse {
  routes?: {
    duration?: string;
    distanceMeters?: number;
    legs?: {
      duration?: string;
      distanceMeters?: number;
    }[];
  }[];
}

function waypoint(point: GeoPoint) {
  return {
    location: {
      latLng: { latitude: point.latitude, longitude: point.longitude },
    },
    /** A delivery is a real stop, not a pass-through the route may skim past. */
    vehicleStopover: true,
  };
}

/** Protobuf durations arrive as "123.45s". */
function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number.parseFloat(value.replace(/s$/, ""));
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

export interface GoogleRoutesConfig {
  apiKey: string;
  languageCode?: string;
}

export class GoogleRoutesProvider implements TravelTimeProvider {
  readonly name = "googlemaps";

  constructor(private readonly config: GoogleRoutesConfig) {}

  /**
   * Measures one origin → waypoints chain, splitting into chained calls when
   * it exceeds what a single request may carry.
   *
   * Each chunk departs at the previous chunk's predicted arrival plus the
   * dwell at that stop, so traffic for the afternoon half of a long run is
   * priced as afternoon traffic. A single departure time for forty stops
   * would quietly treat the last leg as though it were driven at breakfast.
   */
  async legs(request: TravelLegsRequest): Promise<TravelLegsResult> {
    if (request.waypoints.length === 0) {
      return { legs: [], degraded: false, provider: this.name };
    }

    const legs: TravelLeg[] = [];
    let origin = request.origin;
    let departure = request.departureTime;

    for (
      let index = 0;
      index < request.waypoints.length;
      index += MAX_WAYPOINTS_PER_CALL
    ) {
      const chunk = request.waypoints.slice(
        index,
        index + MAX_WAYPOINTS_PER_CALL,
      );

      const measured = await this.call(origin, chunk, departure);

      // A short chunk cannot be accumulated: the missing leg is not the last
      // one, it is unknown which, and every arrival after it would be wrong.
      if (measured.length !== chunk.length) {
        throw new Error(
          `routes api returned ${measured.length} of ${chunk.length} legs`,
        );
      }

      legs.push(...measured);

      const travelled = measured.reduce((sum, leg) => sum + leg.durationSeconds, 0);
      const dwelled = measured.length * request.dwellSeconds;
      departure = new Date(departure.getTime() + (travelled + dwelled) * 1000);
      origin = chunk[chunk.length - 1]!;
    }

    return { legs, degraded: false, provider: this.name };
  }

  private async call(
    origin: GeoPoint,
    chunk: GeoPoint[],
    departureTime: Date,
  ): Promise<TravelLeg[]> {
    const destination = chunk[chunk.length - 1]!;
    const intermediates = chunk.slice(0, -1);

    const response = await fetchJson<ComputeRoutesResponse>(ENDPOINT, {
      method: "POST",
      headers: {
        "X-Goog-Api-Key": this.config.apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      timeoutMs: HTTP_TIMEOUT_MS,
      body: {
        origin: waypoint(origin),
        destination: waypoint(destination),
        ...(intermediates.length > 0
          ? { intermediates: intermediates.map(waypoint) }
          : {}),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        // Must be strictly in the future. Chained chunks advance it forward,
        // so it only ever moves later than this floor.
        departureTime: new Date(
          Math.max(departureTime.getTime(), Date.now() + MIN_DEPARTURE_LEAD_MS),
        ).toISOString(),
        computeAlternativeRoutes: false,
        languageCode: this.config.languageCode,
        units: "METRIC",
      },
    });

    const route = response.routes?.[0];
    if (!route?.legs) return [];

    const legs: TravelLeg[] = [];
    for (const leg of route.legs) {
      const durationSeconds = parseDuration(leg.duration);
      // A leg with no duration is the one thing this whole call exists to
      // produce. Stopping here degrades the run rather than reporting a zero
      // that would pull every later arrival earlier.
      if (durationSeconds === null) return [];
      legs.push({ durationSeconds, distanceMeters: leg.distanceMeters ?? 0 });
    }

    return legs;
  }
}
