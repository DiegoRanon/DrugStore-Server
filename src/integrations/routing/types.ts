/**
 * Route optimization port (PRD §5.4).
 *
 * The server brokers all provider access — credentials never reach the mobile
 * client or the dashboard browser. Defining this as a port means the state
 * machine and driver flow stay testable without credentials, and it is what
 * let the Google Route Optimization adapter land without touching a single
 * route handler.
 *
 * Two adapters exist: `FakeOptimizer` (default, credential-free, sorts by
 * address) and `GoogleRouteOptimizer`. The `mapbox` setting is still accepted
 * by the environment schema and still falls back to the fake — see index.ts.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** An absolute interval a stop must be served within. */
export interface TimeWindow {
  /** ISO 8601 instant. */
  start: string;
  /** ISO 8601 instant, always after `start`. */
  end: string;
}

export interface RouteStop {
  orderId: string;
  address: string;
  /**
   * Where the address actually is. Absent when the address was typed by hand
   * and never geocoded — an adapter must still return such a stop, appended
   * in its incoming order, rather than dropping it. A stop the optimizer
   * cannot place is still a package in the van.
   */
  location?: GeoPoint;
  /**
   * When the pharmacy promised the patient. Derived from the order's time
   * range, its requested time, or the organization's AM/PM window, in that
   * order (see modules/orders/timeWindows.ts).
   */
  timeWindow?: TimeWindow;
  /** Flagged urgent by staff or the driver. */
  isPriority?: boolean;
}

export interface OptimizeRequest {
  /** The driver's current position, when the app supplied one. */
  origin?: GeoPoint;
  /**
   * The pharmacy. A route starts and ends here when the driver's live
   * position is unknown, which is every optimization run made from the
   * dashboard before the driver has left.
   */
  depot?: GeoPoint;
  stops: RouteStop[];
}

export interface OptimizeResult {
  /** Stop order to write into `orders.sequence_number`. */
  orderedOrderIds: string[];
  /**
   * True when the provider could not be reached and the previous ordering was
   * kept. PRD §5.4 is explicit that a Mapbox failure must not block a driver —
   * it degrades, it does not error.
   */
  degraded: boolean;
  provider: string;
}

/** Travel from the previous point on the route to this stop. */
export interface StopEstimate {
  orderId: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
}

export interface EstimateResult {
  estimates: StopEstimate[];
  degraded: boolean;
  provider: string;
}

export interface RouteOptimizer {
  readonly name: string;
  optimize(request: OptimizeRequest): Promise<OptimizeResult>;
  /**
   * Per-stop distance and duration, for a driver choosing their own route
   * ("Le livreur determine manuellement l'itineraire le plus rapide ... en
   * tenant compte de l'estimation de distance faite par l'application").
   *
   * An adapter that cannot estimate returns nulls rather than guesses. A
   * fabricated distance would be used to make a real routing decision, which
   * is worse than showing nothing.
   */
  estimate(request: OptimizeRequest): Promise<EstimateResult>;
}
