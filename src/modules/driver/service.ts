import type { FastifyBaseLogger } from "fastify";

import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { db } from "../../db/knex.js";
import {
  getRouteOptimizer,
  type GeoPoint,
} from "../../integrations/routing/index.js";
import { NotificationsService } from "../notifications/service.js";
import {
  OrdersRepository,
  type DeliveryFailureReason,
  type OrderPackageRow,
  type OrderRow,
  type PaymentException,
  type PaymentMethod,
} from "../orders/repository.js";
import {
  toDriverOrderView,
  type ClosedDriverOrderView,
  type DriverOrderView,
} from "../orders/serializers.js";
import { OrdersService } from "../orders/service.js";
import { isTerminal } from "../orders/stateMachine.js";

export interface StopEstimateView {
  order_id: string;
  distance_meters: number | null;
  duration_seconds: number | null;
}

export interface QueueTotals {
  stop_count: number;
  priority_count: number;
  payment_stop_count: number;
  amount_due_total: number;
  requires_payment_terminal: boolean;
  packages_to_return: number;
}

export interface DriverQueue {
  date: string;
  /** For the native dialer (PRD §5.7) — no server telephony involved. */
  pharmacy: {
    name: string;
    phone: string | null;
    return_deadline: string | null;
  };
  stops: DriverOrderView[];
  to_return: ClosedDriverOrderView[];
  closed: ClosedDriverOrderView[];
  totals: QueueTotals;
  estimates?: StopEstimateView[];
  unread_notifications: number;
  has_new: boolean;
  last_updated_at: string | null;
  degraded?: boolean;
}

export interface PaymentResult {
  order: DriverOrderView;
  amount_due: number | null;
  amount_collected: number;
  /** False when the driver collected something other than the amount owed. */
  matches_amount_due: boolean;
}

export interface CompleteInput {
  payment?: { payment_method: PaymentMethod; amount_collected: number };
  payment_exception?: PaymentException;
  payment_exception_note?: string;
}

export interface ReturnInput {
  reason: DeliveryFailureReason;
  note?: string;
}

export class DriverService {
  private readonly repo: OrdersRepository;
  private readonly orders: OrdersService;
  private readonly notifications: NotificationsService;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new OrdersRepository(ctx);
    this.orders = new OrdersService(ctx, log);
    this.notifications = new NotificationsService(ctx, log);
  }

  // --- queue ---------------------------------------------------------------

  /**
   * The driver's whole day: what to deliver, what is owed back to the
   * pharmacy, and what is already finished.
   *
   * Scheduled orders never appear here — the calendar belongs to the admin
   * until staff declare an order ready, and the repository filters them out of
   * every driver query rather than trusting each call site.
   */
  async getQueue(
    date: string,
    options: { updatedSince?: Date } = {},
  ): Promise<DriverQueue> {
    const [active, toReturn, closed, pharmacy, lastUpdated, unread] =
      await Promise.all([
        this.repo.listQueue(date),
        this.repo.listAwaitingHandover(date),
        this.repo.listClosedForDate(date),
        this.repo.findOrganizationContact(),
        this.repo.latestUpdateForDate(date),
        this.notifications.countUnread(),
      ]);

    const packages = await this.repo.listPackagesForOrders([
      ...active.map((o) => o.id),
      ...toReturn.map((o) => o.id),
      ...closed.map((o) => o.id),
    ]);

    const view = (row: OrderRow): DriverOrderView =>
      toDriverOrderView(row, packages.get(row.id) ?? []);

    return {
      date,
      pharmacy,
      // Every order leaves through the driver serializer, so one whose
      // delivery attempt is over physically cannot carry patient details.
      stops: active.map(view),
      to_return: toReturn.map(view) as ClosedDriverOrderView[],
      closed: closed.map(view) as ClosedDriverOrderView[],
      totals: buildTotals(active, toReturn, packages),
      unread_notifications: unread,
      has_new: options.updatedSince
        ? lastUpdated !== null && lastUpdated > options.updatedSince
        : false,
      last_updated_at: lastUpdated?.toISOString() ?? null,
    };
  }

  /**
   * Writes the stop order the driver chose (domain workflow, en route: "Le
   * livreur détermine manuellement l'itinéraire le plus rapide").
   *
   * The optimizer suggests; this is the driver overruling it. Anything the
   * caller omits keeps no position, so a partial list is not silently treated
   * as the whole route.
   */
  async setSequence(date: string, orderedIds: string[]): Promise<DriverQueue> {
    const active = await this.repo.listQueue(date);
    const known = new Set(active.map((order) => order.id));

    const unknown = orderedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new AppError(
        "ORDER_INVALID_TRANSITION",
        "One or more orders are not active stops on this driver's route for that date",
        { unknown_order_ids: unknown, date },
      );
    }

    const deduped = [...new Set(orderedIds)];
    if (deduped.length !== orderedIds.length) {
      throw new AppError(
        "VALIDATION_FAILED",
        "ordered_order_ids contains duplicates",
      );
    }

    await db.transaction(async (trx) => {
      await new OrdersRepository(this.ctx, trx).resequence(trx, {
        driverId: this.ctx.userId,
        date,
        orderedIds: deduped,
      });
    });

    return this.getQueue(date);
  }

  /**
   * Suggests a stop order and travel estimates for a day (PRD §5.4).
   *
   * A provider failure must never block a driver: the previous sequence is
   * kept and the response is flagged degraded rather than returning an error,
   * because a driver holding packages needs *a* list far more than an optimal
   * one.
   */
  async optimizeQueue(date: string, origin?: GeoPoint): Promise<DriverQueue> {
    const active = await this.repo.listQueue(date);

    if (active.length === 0) {
      return this.getQueue(date);
    }

    const optimizer = getRouteOptimizer();
    const request = {
      origin,
      stops: active.map((order) => ({
        orderId: order.id,
        address: order.address,
      })),
    };

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
        { err: error, provider: optimizer.name, date },
        "route optimization failed — keeping the previous sequence",
      );
      orderedIds = active.map((order) => order.id);
      degraded = true;
    }

    await db.transaction(async (trx) => {
      await new OrdersRepository(this.ctx, trx).resequence(trx, {
        driverId: this.ctx.userId,
        date,
        orderedIds,
      });
    });

    /**
     * Estimates are a separate concern from the ordering, and deliberately do
     * not feed the `degraded` flag: that flag tells the driver app "this route
     * is not the optimizer's answer, it is your previous one", which is what
     * it warns about. An adapter that can order but not measure has given a
     * perfectly good route. Absent estimates say so by being absent.
     */
    let estimates: StopEstimateView[] | undefined;
    try {
      const result = await optimizer.estimate(request);
      if (!result.degraded) {
        estimates = result.estimates.map((estimate) => ({
          order_id: estimate.orderId,
          distance_meters: estimate.distanceMeters,
          duration_seconds: estimate.durationSeconds,
        }));
      }
    } catch (error) {
      this.log.warn(
        { err: error, provider: optimizer.name, date },
        "route estimation failed — returning the queue without estimates",
      );
    }

    const queue = await this.getQueue(date);
    return { ...queue, estimates, degraded };
  }

  // --- transitions ---------------------------------------------------------

  /**
   * Takes physical custody, optionally recording the package count the driver
   * checked against the employee's labels.
   */
  async pickup(
    orderId: string,
    input: { confirmed_package_count?: number } = {},
  ): Promise<DriverOrderView> {
    const patch =
      input.confirmed_package_count === undefined
        ? undefined
        : { pickup_package_count: input.confirmed_package_count };

    const row = await this.orders.transitionRow(orderId, "pickup", { patch });

    if (input.confirmed_package_count !== undefined) {
      const expected = (await this.repo.listPackages(orderId)).length;
      if (expected > 0 && expected !== input.confirmed_package_count) {
        // Not an error: the driver is standing at the counter and the physical
        // bags are the truth. Surfaced so the pharmacy can reconcile the
        // difference rather than discover it at the door.
        this.log.warn(
          {
            order_id: orderId,
            expected_package_count: expected,
            confirmed_package_count: input.confirmed_package_count,
          },
          "driver confirmed a different package count than the order lists",
        );
      }
    }

    return this.view(row);
  }

  /**
   * Proof of delivery, with what happened at the door in the same call.
   *
   * The payment and the completion are one transaction because they are one
   * event: the driver hands over the bag and takes the money in a single
   * motion, and a crash between two requests would leave a delivered order
   * looking unpaid — or worse, money recorded against an order the app never
   * managed to complete.
   */
  async complete(
    orderId: string,
    input: CompleteInput = {},
  ): Promise<DriverOrderView> {
    const existing = await this.requireOrder(orderId);

    if (input.payment && existing.payment_collected) {
      throw new AppError(
        "PAYMENT_ALREADY_COLLECTED",
        "Payment has already been recorded for this delivery",
        { collected_at: existing.payment_collected_at?.toISOString() ?? null },
      );
    }

    const patch: Partial<OrderRow> = {};

    if (input.payment) {
      patch.payment_method = input.payment.payment_method;
      patch.amount_collected = input.payment.amount_collected;
      patch.payment_collected = true;
      patch.payment_collected_at = new Date();
      // The server owns the business state; clients never write
      // payment_status directly outside order creation (PRD §5.5).
      patch.payment_status = "paid";
    }

    if (input.payment_exception) {
      patch.payment_exception = input.payment_exception;
      patch.payment_exception_note = input.payment_exception_note ?? null;
    }

    const row = await this.orders.transitionRow(orderId, "complete", {
      patch: Object.keys(patch).length > 0 ? patch : undefined,
    });

    if (input.payment) {
      this.logAmountMismatch(row, input.payment.amount_collected);
    }

    if (input.payment_exception) {
      this.log.warn(
        {
          order_id: orderId,
          payment_exception: input.payment_exception,
          amount_due: row.amount_due,
        },
        "delivery completed without collecting the amount due",
      );
    }

    return this.view(row);
  }

  /**
   * The delivery failed (scénario B). The reason is required — a return with
   * no explanation tells the pharmacy nothing about whether to re-attempt.
   *
   * This does NOT end the order. The package is in the driver's van until it
   * is handed back at the pharmacy; handover() is that confirmation.
   */
  async return(orderId: string, input: ReturnInput): Promise<DriverOrderView> {
    const row = await this.orders.transitionRow(orderId, "return", {
      patch: {
        failure_reason: input.reason,
        failure_note: input.note ?? null,
      },
    });

    this.log.info(
      { order_id: orderId, failure_reason: input.reason },
      "delivery failed; package awaiting handover",
    );

    return this.view(row);
  }

  /**
   * "Une fois les commandes retourné, le livreur peut confirmer sur
   *  l'application que la pharmacie les as biens récupéré."
   *
   * Batched, because the driver hands the whole stack over at the counter in
   * one go. All or nothing: a partial success would leave the driver unsure
   * which packages the app still thinks they are holding.
   */
  async handover(orderIds: string[]): Promise<ClosedDriverOrderView[]> {
    const unique = [...new Set(orderIds)];

    const rows = await db.transaction(async (trx) => {
      const handed: OrderRow[] = [];
      for (const orderId of unique) {
        handed.push(
          await this.orders.transitionRow(orderId, "handover", { trx }),
        );
      }
      return handed;
    });

    this.log.info(
      { order_count: rows.length },
      "returned packages handed back to the pharmacy",
    );

    const packages = await this.repo.listPackagesForOrders(
      rows.map((row) => row.id),
    );

    return rows.map(
      (row) =>
        toDriverOrderView(row, packages.get(row.id) ?? []) as ClosedDriverOrderView,
    );
  }

  /** The employee flags an urgent stop verbally at pickup, so the driver sets it. */
  async setPriority(
    orderId: string,
    isPriority: boolean,
  ): Promise<DriverOrderView> {
    const existing = await this.requireOrder(orderId);

    if (isTerminal(existing.status)) {
      throw new AppError(
        "ORDER_ALREADY_TERMINAL",
        `Cannot change the priority of an order that is ${existing.status}`,
        { current_status: existing.status },
      );
    }

    const row = await this.repo.setPriority(orderId, isPriority);
    if (!row) throw new AppError("NOT_FOUND", "Order not found");
    return this.view(row);
  }

  // --- payment -------------------------------------------------------------

  /**
   * Records a collection made at the door on a physical POS (PRD §5.5). No
   * card data is ever accepted — only that money changed hands, by what
   * method, and how much.
   *
   * Kept alongside complete()'s inline payment for the case the workflow
   * actually produces: the driver completed the delivery and only then got the
   * terminal to go through.
   */
  async recordPayment(
    orderId: string,
    input: { payment_method: PaymentMethod; amount_collected: number },
  ): Promise<PaymentResult> {
    const order = await this.requireOrder(orderId);

    // Payment presupposes the driver reached the patient. A failed delivery
    // stays unpaid by definition.
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

    const matches = this.logAmountMismatch(updated, input.amount_collected);

    return {
      order: await this.view(updated),
      amount_due: order.amount_due,
      amount_collected: input.amount_collected,
      matches_amount_due: matches,
    };
  }

  /**
   * Partial and over-payments happen at the door; neither is an error. The
   * warning exists so the pharmacy can reconcile at end of shift rather than
   * discover the gap in a monthly total.
   */
  private logAmountMismatch(row: OrderRow, collected: number): boolean {
    const matches =
      row.amount_due === null || Math.abs(row.amount_due - collected) < 0.005;

    if (!matches) {
      this.log.warn(
        {
          order_id: row.id,
          amount_due: row.amount_due,
          amount_collected: collected,
        },
        "collected amount does not match amount due",
      );
    }
    return matches;
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

    // The attempt has to be over — completed, or failed and on its way back.
    if (order.status === "in_pharmacy" || order.status === "picked_up") {
      throw new AppError(
        "ORDER_INVALID_TRANSITION",
        "The cooler bag check happens after a delivery is completed or returned",
        { current_status: order.status },
      );
    }

    const updated = await this.repo.recordCoolerCheck(orderId, confirmed);
    if (!updated) throw new AppError("NOT_FOUND", "Order not found");
    return this.view(updated);
  }

  // --- notifications -------------------------------------------------------

  listNotifications(options: { unreadOnly: boolean; limit: number }) {
    return this.notifications.list(options);
  }

  markNotificationsRead(ids?: string[]) {
    return this.notifications.markRead(ids);
  }

  private async view(row: OrderRow): Promise<DriverOrderView> {
    return toDriverOrderView(row, await this.repo.listPackages(row.id));
  }

  private async requireOrder(orderId: string): Promise<OrderRow> {
    // Scoped to this driver by the repository, so another driver's order is
    // indistinguishable from one that does not exist.
    const order = await this.repo.findById(orderId);
    if (!order) throw new AppError("NOT_FOUND", "Order not found");
    return order;
  }
}

/**
 * The numbers the driver needs before leaving the pharmacy: how much money to
 * expect, and therefore whether to take the POS terminal at all ("Le livreur
 * ramasse le terminale de paiement si des commande requiert une récolte de
 * paiement").
 */
function buildTotals(
  active: OrderRow[],
  toReturn: OrderRow[],
  packages: Map<string, OrderPackageRow[]>,
): QueueTotals {
  const owing = active.filter(
    (order) =>
      !order.payment_collected &&
      order.payment_status === "unpaid" &&
      order.amount_due !== null &&
      order.amount_due > 0,
  );

  const amountDue = owing.reduce(
    (total, order) => total + (order.amount_due ?? 0),
    0,
  );

  return {
    stop_count: active.length,
    priority_count: active.filter((order) => order.is_priority).length,
    payment_stop_count: owing.length,
    // Cents, then back: floating-point addition of currency drifts, and this
    // number is read against the cash in the driver's pocket.
    amount_due_total: Math.round(amountDue * 100) / 100,
    requires_payment_terminal: owing.length > 0,
    packages_to_return: toReturn.reduce(
      (total, order) => total + (packages.get(order.id)?.length ?? 0),
      0,
    ),
  };
}
