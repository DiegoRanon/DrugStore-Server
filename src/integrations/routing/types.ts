/**
 * Route optimization port (PRD §5.4).
 *
 * The server brokers all Mapbox access — tokens never reach the mobile client.
 * Defining this as a port means the state machine and driver flow are testable
 * without credentials, and the Mapbox adapter in Phase 5 slots in behind the
 * same contract.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface RouteStop {
  orderId: string;
  address: string;
}

export interface OptimizeRequest {
  /** The driver's current position, when the app supplied one. */
  origin?: GeoPoint;
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
