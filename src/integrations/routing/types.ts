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

export interface RouteOptimizer {
  readonly name: string;
  optimize(request: OptimizeRequest): Promise<OptimizeResult>;
}
