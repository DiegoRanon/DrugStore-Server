import type { FastifyBaseLogger } from "fastify";

import type { RequestContext } from "../../core/context.js";
import { db } from "../../db/knex.js";
import {
  getRouteOptimizer,
  type GeoPoint,
  type OptimizeRequest,
} from "../../integrations/routing/index.js";
import { OrdersRepository, type OrderRow } from "./repository.js";
import {
  deliveryTimeWindow,
  type TimeRangeOverride,
} from "./timeWindows.js";

/**
 * Route optimization, shared by the driver app and the admin dashboard.
 *
 * Both callers want exactly the same thing — take one driver's active stops
 * for one day, ask the provider for an order, write it to
 * `orders.sequence_number` — and they used to be able to want it in only one
 * place, because the logic lived inside DriverService and read the driver id
 * off the authenticated context. An admin optimizing a route for someone else
 * has no such id to read, which is why this moved out.
 *
 * DEGRADATION IS THE POINT
 *
 * PRD §5.4 is explicit that a provider failure must not block a driver. A
 * driver standing in the pharmacy holding packages needs *a* list far more
 * than an optimal one, so every failure path here ends with the previous
 * sequence intact and `degraded: true` on the response, never an error.
 *
 * WHAT degraded MEANS
 *
 * Only "this order is your previous one, not the optimizer's answer". It is
 * deliberately not set when estimates are missing: an adapter that can order
 * but not measure has still given a perfectly good route, and absent
 * estimates say so by being absent.
 */

export interface StopEstimateView {
  order_id: string;
  distance_meters: number | null;
  duration_seconds: number | null;
}

export interface OptimizeOutcome {
  orderedIds: string[];
  degraded: boolean;
  estimates?: StopEstimateView[];
  /** Stops with no coordinate, appended rather than routed. */
  unroutableOrderIds: string[];
}

export interface OptimizeOptions {
  /** The driver's live position, when the app supplied one. */
  origin?: GeoPoint;
  /**
   * A range the admin chose for this run. Applies only to stops carrying no
   * promise of their own — see resolveWindowMinutes().
   */
  timeRange?: TimeRangeOverride;
}

export class RouteService {
  private readonly repo: OrdersRepository;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new OrdersRepository(ctx);
  }

  /**
   * Optimizes and persists one driver's stop order for one day.
   *
   * Returns the outcome rather than a queue: the driver app wants its queue
   * back and the dashboard wants an order list, and building both here would
   * make this depend on two presentation layers.
   */
  async optimizeForDriver(
    driverId: string,
    date: string,
    options: OptimizeOptions = {},
  ): Promise<OptimizeOutcome> {
    const active = await this.repo.listQueue(date, driverId);

    if (active.length === 0) {
      return { orderedIds: [], degraded: false, unroutableOrderIds: [] };
    }

    const hours = await this.repo.findOrganizationRouting();
    const optimizer = getRouteOptimizer();

    const depot: GeoPoint | undefined =
      hours.latitude !== null && hours.longitude !== null
        ? { latitude: hours.latitude, longitude: hours.longitude }
        : undefined;

    const request: OptimizeRequest = {
      origin: options.origin,
      depot,
      stops: active.map((order) => ({
        orderId: order.id,
        address: order.address,
        location: toLocation(order),
        timeWindow: deliveryTimeWindow(order, hours, options.timeRange),
        isPriority: order.is_priority,
      })),
    };

    const unroutableOrderIds = active
      .filter((order) => toLocation(order) === undefined)
      .map((order) => order.id);

    if (unroutableOrderIds.length > 0) {
      this.log.info(
        { driver_id: driverId, date, count: unroutableOrderIds.length },
        "stops without coordinates will be appended rather than routed",
      );
    }

    let orderedIds: string[];
    let degraded = false;

    try {
      const result = await optimizer.optimize(request);

      const known = new Set(active.map((o) => o.id));
      orderedIds = result.orderedOrderIds.filter((id) => known.has(id));

      // A provider that drops or invents stops cannot be trusted for this
      // run; keep what the driver already had.
      if (orderedIds.length !== active.length) {
        throw new Error(
          `optimizer returned ${orderedIds.length} of ${active.length} stops`,
        );
      }
      degraded = result.degraded;
    } catch (error) {
      this.log.error(
        { err: error, provider: optimizer.name, driver_id: driverId, date },
        "route optimization failed — keeping the previous sequence",
      );
      orderedIds = active.map((order) => order.id);
      degraded = true;
    }

    await db.transaction(async (trx) => {
      await new OrdersRepository(this.ctx, trx).resequence(trx, {
        driverId,
        date,
        orderedIds,
      });
    });

    return {
      orderedIds,
      degraded,
      estimates: await this.measure(request, optimizer, date),
      unroutableOrderIds,
    };
  }

  /**
   * Per-stop distance and duration, when the provider can measure them.
   *
   * Failures here are warnings, not errors: the route has already been
   * written and is useful without numbers beside it.
   */
  private async measure(
    request: OptimizeRequest,
    optimizer: ReturnType<typeof getRouteOptimizer>,
    date: string,
  ): Promise<StopEstimateView[] | undefined> {
    try {
      const result = await optimizer.estimate(request);
      if (result.degraded) return undefined;

      return result.estimates.map((estimate) => ({
        order_id: estimate.orderId,
        distance_meters: estimate.distanceMeters,
        duration_seconds: estimate.durationSeconds,
      }));
    } catch (error) {
      this.log.warn(
        { err: error, provider: optimizer.name, date },
        "route estimation failed — returning the route without estimates",
      );
      return undefined;
    }
  }
}

function toLocation(order: OrderRow): GeoPoint | undefined {
  return order.latitude !== null && order.longitude !== null
    ? { latitude: order.latitude, longitude: order.longitude }
    : undefined;
}
