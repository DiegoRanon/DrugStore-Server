import type { FastifyBaseLogger } from "fastify";

import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { db } from "../../db/knex.js";
import { getRouteOptimizer, type GeoPoint } from "../../integrations/routing/index.js";
import { OrdersRepository, type OrderRow, type PaymentMethod } from "../orders/repository.js";
import {
  toDriverOrderView,
  type ClosedDriverOrderView,
  type DriverOrderView,
} from "../orders/serializers.js";
import { OrdersService } from "../orders/service.js";
import { isTerminal, type TransitionName } from "../orders/stateMachine.js";

export interface DriverQueue {
  date: string;
  /** For the native dialer (PRD §5.7) — no server telephony involved. */
  pharmacy: { name: string; phone: string | null };
  stops: DriverOrderView[];
  closed: ClosedDriverOrderView[];
  degraded?: boolean;
}

export interface PaymentResult {
  order: DriverOrderView;
  amount_due: number | null;
  amount_collected: number;
  /** False when the driver collected something other than the amount owed. */
  matches_amount_due: boolean;
}

export class DriverService {
  private readonly repo: OrdersRepository;
  private readonly orders: OrdersService;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new OrdersRepository(ctx);
    this.orders = new OrdersService(ctx, log);
  }

  // --- queue ---------------------------------------------------------------

  async getQueue(date: string): Promise<DriverQueue> {
    const [active, closed, pharmacy] = await Promise.all([
      this.repo.listQueue(date),
      this.repo.listClosedForDate(date),
      this.repo.findOrganizationContact(),
    ]);

    return {
      date,
      pharmacy,
      // Every order leaves through the driver serializer, so a terminal one
      // physically cannot carry patient details (PRD §8.3).
      stops: active.map(toDriverOrderView),
      closed: closed.map(toDriverOrderView) as ClosedDriverOrderView[],
    };
  }

  /**
   * Recalculates the driver's stop order for a day (PRD §5.4).
   *
   * A provider failure must never block a driver: the previous sequence is
   * kept and the response is flagged `degraded` rather than returning an
   * error, because a driver holding packages needs *a* list far more than an
   * optimal one.
   */
  async optimizeQueue(
    date: string,
    origin?: GeoPoint,
  ): Promise<DriverQueue> {
    const active = await this.repo.listQueue(date);

    if (active.length === 0) {
      return this.getQueue(date);
    }

    const optimizer = getRouteOptimizer();
    let orderedIds: string[];
    let degraded = false;

    try {
      const result = await optimizer.optimize({
        origin,
        stops: active.map((order) => ({
          orderId: order.id,
          address: order.address,
        })),
      });

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
        { err: error, provider: optimizer.name, date },
        "route optimization failed — keeping the previous sequence",
      );
      orderedIds = active.map((order) => order.id);
      degraded = true;
    }

    await db.transaction(async (trx) => {
      await this.repo.resequence(trx, {
        driverId: this.ctx.userId,
        date,
        orderedIds,
      });
    });

    const queue = await this.getQueue(date);
    return { ...queue, degraded };
  }

  // --- transitions ---------------------------------------------------------

  /**
   * Delegates to the same state machine the admin surface uses, then applies
   * the driver serializer. No transition logic is duplicated here.
   */
  private async runTransition(
    orderId: string,
    transition: TransitionName,
  ): Promise<DriverOrderView> {
    const row = await this.orders.transitionRow(orderId, transition);
    return toDriverOrderView(row);
  }

  pickup(orderId: string): Promise<DriverOrderView> {
    return this.runTransition(orderId, "pickup");
  }

  complete(orderId: string): Promise<DriverOrderView> {
    return this.runTransition(orderId, "complete");
  }

  return(orderId: string): Promise<DriverOrderView> {
    return this.runTransition(orderId, "return");
  }

  // --- payment -------------------------------------------------------------

  /**
   * Records a collection made at the door on a physical POS (PRD §5.5). No
   * card data is ever accepted — only that money changed hands, by what
   * method, and how much.
   */
  async recordPayment(
    orderId: string,
    input: { payment_method: PaymentMethod; amount_collected: number },
  ): Promise<PaymentResult> {
    const order = await this.requireOrder(orderId);

    // Payment presupposes the driver reached the patient. A returned order
    // stays unpaid by definition (PRD §5.3).
    if (order.status !== "picked_up" && order.status !== "completed") {
      throw new AppError(
        "ORDER_INVALID_TRANSITION",
        `Payment can only be recorded on a delivery in progress or completed (this one is ${order.status})`,
        { current_status: order.status },
      );
    }

    if (order.payment_collected) {
      throw new AppError(
        "PAYMENT_ALREADY_COLLECTED",
        "Payment has already been recorded for this delivery",
        { collected_at: order.payment_collected_at?.toISOString() ?? null },
      );
    }

    const updated = await this.repo.recordPayment(orderId, input);
    if (!updated) throw new AppError("NOT_FOUND", "Order not found");

    const matches =
      order.amount_due === null ||
      Math.abs(order.amount_due - input.amount_collected) < 0.005;

    if (!matches) {
      // Not an error — partial and over-payments happen at the door. It is
      // surfaced so the pharmacy can reconcile.
      this.log.warn(
        {
          order_id: orderId,
          amount_due: order.amount_due,
          amount_collected: input.amount_collected,
        },
        "collected amount does not match amount due",
      );
    }

    return {
      order: toDriverOrderView(updated),
      amount_due: order.amount_due,
      amount_collected: input.amount_collected,
      matches_amount_due: matches,
    };
  }

  // --- quality control -----------------------------------------------------

  /**
   * Post-delivery cooler-bag check (PRD §5.6). A quality record, never a
   * blocker — a driver who dismisses the prompt simply never calls this, and
   * the column stays NULL for the admin exceptions report.
   */
  async recordCoolerCheck(
    orderId: string,
    confirmed: boolean,
  ): Promise<DriverOrderView> {
    const order = await this.requireOrder(orderId);

    if (!order.requires_cooler_bag) {
      throw new AppError(
        "COOLER_BAG_NOT_REQUIRED",
        "This delivery does not require a cooler bag",
      );
    }

    if (!isTerminal(order.status)) {
      throw new AppError(
        "ORDER_INVALID_TRANSITION",
        "The cooler bag check happens after a delivery is completed or returned",
        { current_status: order.status },
      );
    }

    const updated = await this.repo.recordCoolerCheck(orderId, confirmed);
    if (!updated) throw new AppError("NOT_FOUND", "Order not found");
    return toDriverOrderView(updated);
  }

  private async requireOrder(orderId: string): Promise<OrderRow> {
    // Scoped to this driver by the repository, so another driver's order is
    // indistinguishable from one that does not exist.
    const order = await this.repo.findById(orderId);
    if (!order) throw new AppError("NOT_FOUND", "Order not found");
    return order;
  }
}
