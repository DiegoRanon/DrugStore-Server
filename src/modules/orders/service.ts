import type { FastifyBaseLogger } from "fastify";
import type { Knex } from "knex";

import { auditPiiRead } from "../../core/audit.js";
import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { buildPage, decodeCursor, type Page } from "../../core/pagination.js";
import { db } from "../../db/knex.js";
import { ClientsRepository } from "../clients/repository.js";
import {
  RouteService,
  type StopEstimateView,
} from "./routeService.js";
import { NotificationsService } from "../notifications/service.js";
import type { DriverNotificationType } from "../notifications/repository.js";
import {
  OrdersRepository,
  type DeliveryWindow,
  type OrderPackageRow,
  type OrderRow,
  type PackageType,
  type PaymentStatus,
} from "./repository.js";
import {
  toAdminOrderView,
  toStatusEventView,
  type AdminOrderView,
  type StatusEventView,
} from "./serializers.js";
import {
  assertTransitionAllowed,
  availableTransitions,
  isTerminal,
  TRANSITIONS,
  type OrderStatus,
  type TransitionName,
} from "./stateMachine.js";

export interface OrderPackageInput {
  label_code: string;
  package_type?: PackageType;
}

export interface CreateOrderInput {
  client_id: string;
  driver_id?: string | null;
  patient_name?: string;
  address?: string;
  phone_number?: string;
  authorized_recipient?: string | null;
  place_id?: string | null;
  formatted_address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  delivery_date: string;
  delivery_window: DeliveryWindow;
  requested_delivery_time?: string | null;
  requested_time_start?: string | null;
  requested_time_end?: string | null;
  payment_status?: PaymentStatus;
  amount_due?: number | null;
  requires_cooler_bag?: boolean;
  is_priority?: boolean;
  packages?: OrderPackageInput[];
}

export interface UpdateOrderInput {
  patient_name?: string;
  address?: string;
  phone_number?: string;
  authorized_recipient?: string | null;
  place_id?: string | null;
  formatted_address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  delivery_date?: string;
  delivery_window?: DeliveryWindow;
  requested_delivery_time?: string | null;
  requested_time_start?: string | null;
  requested_time_end?: string | null;
  payment_status?: PaymentStatus;
  amount_due?: number | null;
  requires_cooler_bag?: boolean;
  is_priority?: boolean;
  packages?: OrderPackageInput[];
}

export interface OrderDetailView extends AdminOrderView {
  status_events: StatusEventView[];
  available_transitions: TransitionName[];
}

export interface CalendarView {
  from: string;
  to: string;
  days: {
    delivery_date: string;
    total: number;
    by_status: Partial<Record<OrderStatus, number>>;
  }[];
}

/** Statuses during which an admin may still edit the order's details. */
const EDITABLE_STATUSES: readonly OrderStatus[] = ["scheduled", "in_pharmacy"];

export class OrdersService {
  private readonly repo: OrdersRepository;
  private readonly clients: ClientsRepository;
  private readonly notifications: NotificationsService;
  private readonly routes: RouteService;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new OrdersRepository(ctx);
    this.clients = new ClientsRepository(ctx);
    this.notifications = new NotificationsService(ctx, log);
    this.routes = new RouteService(ctx, log);
  }

  // --- creation ------------------------------------------------------------

  /**
   * Creates an order in the admin's calendar, snapshotting the client's
   * logistics details onto it (PRD §5.2).
   *
   * It starts "scheduled", not "in_pharmacy": the pharmacy takes the order by
   * phone or in person days ahead, and the bags do not exist yet. Staff call
   * markReady() on the day, once they have physically packed it. Until then
   * the order is admin-only — a driver cannot see it, and the repository cuts
   * scheduled rows out of every driver query rather than relying on the state
   * machine to refuse a pickup.
   *
   * The snapshot is written once, here. There is deliberately no code path
   * anywhere that copies a client's current details onto an existing order —
   * editing a patient's address must never silently rewrite where last
   * month's delivery went.
   */
  async create(input: CreateOrderInput): Promise<AdminOrderView> {
    const client = await this.clients.findById(input.client_id);
    if (!client) throw new AppError("NOT_FOUND", "Client not found");

    if (!client.is_active) {
      throw new AppError(
        "CLIENT_INACTIVE",
        "This client is deactivated. Reactivate them before creating a delivery.",
      );
    }

    if (input.driver_id) {
      const driver = await this.repo.findAssignableDriver(input.driver_id);
      if (!driver) {
        throw new AppError(
          "NOT_FOUND",
          "Driver not found in this organization",
        );
      }
    }

    const packages = input.packages ?? [];

    const { row, packageRows } = await db.transaction(async (trx) => {
      const repo = new OrdersRepository(this.ctx, trx);
      const created = await repo.create(
        {
          client_id: client.id,
          driver_id: input.driver_id ?? null,
          // Caller-supplied values win, so an order can be corrected per
          // delivery ("apartment 4B this time") without touching the client.
          patient_name: input.patient_name ?? client.name,
          address: input.address ?? client.address,
          phone_number: input.phone_number ?? client.phone_number,
          authorized_recipient: input.authorized_recipient ?? null,
          // The geocode is snapshotted as one unit with the address it
          // describes. Taking the coordinate from the caller while the
          // address fell back to the client record — or the reverse — would
          // route this delivery to a different place than the one printed on
          // the bag, so the whole geocode follows whichever address won.
          ...(input.address !== undefined || input.latitude != null
            ? {
                place_id: input.place_id ?? null,
                formatted_address: input.formatted_address ?? null,
                latitude: input.latitude ?? null,
                longitude: input.longitude ?? null,
                geocoded_at: input.latitude != null ? new Date() : null,
              }
            : {
                place_id: client.place_id,
                formatted_address: client.formatted_address,
                latitude: client.latitude,
                longitude: client.longitude,
                geocoded_at: client.geocoded_at,
              }),
          delivery_date: input.delivery_date,
          delivery_window: input.delivery_window,
          requested_delivery_time: input.requested_delivery_time ?? null,
          requested_time_start: input.requested_time_start ?? null,
          requested_time_end: input.requested_time_end ?? null,
          payment_status: input.payment_status ?? "unpaid",
          amount_due: input.amount_due ?? null,
          requires_cooler_bag: coolerBagRequired(
            input.requires_cooler_bag,
            packages,
          ),
          is_priority: input.is_priority ?? false,
          status: "scheduled",
        },
        trx,
      );

      const inserted = await repo.replacePackages(trx, created.id, packages);

      // The creation event, so order_status_events is a complete history
      // rather than one that starts at the first change.
      await trx("order_status_events").insert({
        order_id: created.id,
        status: created.status,
        changed_by_user_id: this.ctx.userId,
      });

      return { row: created, packageRows: inserted };
    });

    this.log.info(
      {
        order_id: row.id,
        client_id: client.id,
        package_count: packageRows.length,
      },
      "order created",
    );

    return toAdminOrderView(row, packageRows);
  }

  // --- reads ---------------------------------------------------------------

  async list(options: {
    date?: string;
    from?: string;
    to?: string;
    status?: OrderStatus;
    driverId?: string;
    clientId?: string;
    isPriority?: boolean;
    updatedSince?: Date;
    limit: number;
    cursor?: string;
  }): Promise<Page<AdminOrderView>> {
    const rows = await this.repo.list({
      date: options.date,
      from: options.from,
      to: options.to,
      status: options.status,
      driverId: options.driverId,
      clientId: options.clientId,
      isPriority: options.isPriority,
      updatedSince: options.updatedSince,
      limit: options.limit,
      cursor: options.cursor ? decodeCursor(options.cursor) : undefined,
    });

    const page = buildPage(rows, options.limit, (row) => ({
      sortValue: row.created_at.toISOString(),
      id: row.id,
    }));

    const packages = await this.repo.listPackagesForOrders(
      page.data.map((row) => row.id),
    );

    // Every row carries patient_name, address, and phone_number (§8.4).
    await auditPiiRead(this.ctx, this.log, {
      action: "order.list.read",
      resourceType: "order",
      recordCount: page.data.length,
    });

    return {
      ...page,
      data: page.data.map((row) =>
        toAdminOrderView(row, packages.get(row.id) ?? []),
      ),
    };
  }

  /**
   * Per-day counts for the admin calendar.
   *
   * Deliberately not audit-logged: it returns integers, not a single patient
   * detail, and recording it as a PII read would bury the real accesses in
   * noise every time somebody pages through a month.
   */
  async calendar(range: { from: string; to: string }): Promise<CalendarView> {
    const counts = await this.repo.countByDate(range);

    const byDate = new Map<string, CalendarView["days"][number]>();
    for (const entry of counts) {
      let day = byDate.get(entry.delivery_date);
      if (!day) {
        day = { delivery_date: entry.delivery_date, total: 0, by_status: {} };
        byDate.set(entry.delivery_date, day);
      }
      day.by_status[entry.status] = entry.count;
      day.total += entry.count;
    }

    return { from: range.from, to: range.to, days: [...byDate.values()] };
  }

  async get(id: string): Promise<OrderDetailView> {
    const row = await this.requireOrder(id);
    const [events, packages] = await Promise.all([
      this.repo.listStatusEvents(id),
      this.repo.listPackages(id),
    ]);

    await auditPiiRead(this.ctx, this.log, {
      action: "order.detail.read",
      resourceType: "order",
      resourceIds: [row.id],
    });

    return {
      ...toAdminOrderView(row, packages),
      status_events: events.map(toStatusEventView),
      available_transitions: availableTransitions(row.status),
    };
  }

  private async requireOrder(id: string): Promise<OrderRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new AppError("NOT_FOUND", "Order not found");
    return row;
  }

  // --- edits ---------------------------------------------------------------

  /**
   * Editable only while the order is still at the pharmacy — scheduled in the
   * calendar, or packed and waiting on the counter. Once a driver holds the
   * package, changing the address would mean the delivery they are performing
   * no longer matches the record of it.
   */
  async update(id: string, patch: UpdateOrderInput): Promise<AdminOrderView> {
    const existing = await this.requireOrder(id);

    if (!EDITABLE_STATUSES.includes(existing.status)) {
      throw new AppError(
        "ORDER_NOT_EDITABLE",
        `An order can only be edited before a driver takes it (this one is ${existing.status})`,
        {
          current_status: existing.status,
          editable_statuses: EDITABLE_STATUSES,
        },
      );
    }

    const { packages, ...columns } = patch;

    const result = await db.transaction(async (trx) => {
      const repo = new OrdersRepository(this.ctx, trx);

      const packageRows = packages
        ? await repo.replacePackages(trx, id, packages)
        : await repo.listPackages(id);

      const columnPatch: Partial<OrderRow> = { ...columns };
      if (packages) {
        // Kept in step so the cooler-bag check cannot disagree with what is
        // actually in the bags.
        columnPatch.requires_cooler_bag = coolerBagRequired(
          patch.requires_cooler_bag ?? existing.requires_cooler_bag,
          packages,
        );
      }

      const row =
        Object.keys(columnPatch).length > 0
          ? await repo.update(id, columnPatch, trx)
          : existing;

      if (!row) throw new AppError("NOT_FOUND", "Order not found");
      return { row, packageRows };
    });

    return toAdminOrderView(result.row, result.packageRows);
  }

  /**
   * Assign or reassign a driver. Allowed at any non-terminal point, since
   * reassignment mid-route is a real dispatch need (PRD §12 Q6), and from
   * "scheduled" so dispatch can plan tomorrow's run in the calendar.
   */
  async assignDriver(
    id: string,
    driverId: string | null,
  ): Promise<AdminOrderView> {
    const existing = await this.requireOrder(id);

    if (isTerminal(existing.status)) {
      throw new AppError(
        "ORDER_ALREADY_TERMINAL",
        `Cannot reassign an order that is ${existing.status}`,
        { current_status: existing.status },
      );
    }

    if (driverId) {
      const driver = await this.repo.findAssignableDriver(driverId);
      if (!driver) {
        throw new AppError(
          "NOT_FOUND",
          "Driver not found in this organization",
        );
      }
    }

    const row = await this.repo.update(id, {
      driver_id: driverId,
      // The old driver's route position is meaningless to the new one, and
      // leaving it risks colliding with a position they already hold.
      sequence_number: null,
    });
    if (!row) throw new AppError("NOT_FOUND", "Order not found");

    this.log.info(
      {
        order_id: id,
        previous_driver_id: existing.driver_id,
        driver_id: driverId,
      },
      "order driver assignment changed",
    );

    // Only once the order is on the counter is there anything for a driver to
    // act on. A reassignment inside the calendar is dispatch housekeeping and
    // would just be noise in the feed.
    if (existing.status === "in_pharmacy") {
      if (existing.driver_id && existing.driver_id !== driverId) {
        await this.notify(existing.driver_id, row, "order_unassigned");
      }
      if (driverId && driverId !== existing.driver_id) {
        await this.notify(driverId, row, "order_assigned");
      }
    }

    return this.withPackages(row);
  }

  /** Driver-settable, because the employee flags it verbally at pickup. */
  async setPriority(
    id: string,
    isPriority: boolean,
  ): Promise<AdminOrderView> {
    const existing = await this.requireOrder(id);

    if (isTerminal(existing.status)) {
      throw new AppError(
        "ORDER_ALREADY_TERMINAL",
        `Cannot change the priority of an order that is ${existing.status}`,
        { current_status: existing.status },
      );
    }

    const row = await this.repo.setPriority(id, isPriority);
    if (!row) throw new AppError("NOT_FOUND", "Order not found");
    return this.withPackages(row);
  }

  /**
   * Optimizes one driver's route for one day, from the dashboard.
   *
   * The pharmacy sequences the route before the driver leaves, so the stop
   * order is on their screen at pickup rather than something they have to
   * ask for once they are already out. Delegates to the same RouteService the
   * driver's own optimize button uses — two entry points, one route.
   *
   * The driver is verified to belong to this organization before anything is
   * written: driver_id arrives in the request body, which makes it the one
   * value here that an admin supplies from outside.
   */
  async optimizeRoute(input: {
    date: string;
    driverId: string;
    timeRange?: { start: string; end: string };
  }): Promise<{
    date: string;
    driver_id: string;
    orders: AdminOrderView[];
    degraded: boolean;
    estimates?: StopEstimateView[];
    unroutable_order_ids: string[];
  }> {
    const driver = await this.repo.findAssignableDriver(input.driverId);
    if (!driver) {
      throw new AppError("NOT_FOUND", "Driver not found in this organization");
    }

    const outcome = await this.routes.optimizeForDriver(
      input.driverId,
      input.date,
      { timeRange: input.timeRange },
    );

    // Re-read rather than reorder in memory: resequence() wrote
    // sequence_number, and the queue's sort puts priority stops ahead of it.
    // Returning the ids in the optimizer's order would show the admin a
    // sequence the driver will not see.
    const rows = await this.repo.listQueue(input.date, input.driverId);

    this.log.info(
      {
        driver_id: input.driverId,
        date: input.date,
        stop_count: rows.length,
        degraded: outcome.degraded,
        unroutable: outcome.unroutableOrderIds.length,
      },
      "route optimized from the dashboard",
    );

    return {
      date: input.date,
      driver_id: input.driverId,
      orders: await Promise.all(rows.map((row) => this.withPackages(row))),
      degraded: outcome.degraded,
      estimates: outcome.estimates,
      unroutable_order_ids: outcome.unroutableOrderIds,
    };
  }

  private async withPackages(row: OrderRow): Promise<AdminOrderView> {
    return toAdminOrderView(row, await this.repo.listPackages(row.id));
  }

  // --- state machine -------------------------------------------------------

  /**
   * The single path by which an order's status ever changes.
   *
   * Everything happens in one transaction: the row is locked, the transition
   * is validated against the current status, then the status, its timestamp,
   * any outcome data, and the audit event are written together. A caller
   * cannot produce a status without its timestamp or a change without its
   * event.
   */
  async transitionRow(
    orderId: string,
    transitionName: TransitionName,
    options: { patch?: Partial<OrderRow>; trx?: Knex.Transaction } = {},
  ): Promise<OrderRow> {
    const definition = TRANSITIONS[transitionName];

    const run = async (trx: Knex.Transaction): Promise<OrderRow> => {
      const repo = new OrdersRepository(this.ctx, trx);
      const order = await repo.findByIdForUpdate(orderId, trx);
      if (!order) throw new AppError("NOT_FOUND", "Order not found");

      assertTransitionAllowed({
        transition: transitionName,
        currentStatus: order.status,
        actorRole: this.ctx.role,
        actorUserId: this.ctx.userId,
        assignedDriverId: order.driver_id,
      });

      // Enforced here rather than only in the route body schema, so that any
      // caller reaching the state machine gets the documented 422 instead of a
      // raw chk_failure_reason_present violation surfacing as a 500.
      if (
        definition.to === "returned" &&
        !options.patch?.failure_reason &&
        !order.failure_reason
      ) {
        throw new AppError(
          "FAILURE_REASON_REQUIRED",
          "A failed delivery must record why it failed",
        );
      }

      return repo.applyTransition(trx, {
        orderId,
        status: definition.to,
        timestampColumn: definition.timestampColumn,
        changedByUserId: this.ctx.userId,
        patch: options.patch,
      });
    };

    // Callers that already hold a transaction — the batch handover — pass it
    // in so the whole batch commits or rolls back together.
    const row = options.trx
      ? await run(options.trx)
      : await db.transaction(run);

    this.log.info(
      {
        order_id: orderId,
        transition: transitionName,
        status: definition.to,
        actor_user_id: this.ctx.userId,
      },
      "order status changed",
    );

    return row;
  }

  /**
   * Admin-facing wrapper. Driver routes call transitionRow and apply the
   * driver serializer instead, so the same state machine serves both without
   * either context borrowing the other's response shape.
   */
  async transition(
    orderId: string,
    transitionName: TransitionName,
    options: { patch?: Partial<OrderRow> } = {},
  ): Promise<AdminOrderView> {
    return this.withPackages(
      await this.transitionRow(orderId, transitionName, options),
    );
  }

  /**
   * Staff have physically prepared the order (domain workflow: "les employés
   * préparent physiquement la commande et la déclare comme prête à être prise
   * en charge"). This is the moment it becomes visible to its driver.
   */
  async markReady(orderId: string): Promise<AdminOrderView> {
    const row = await this.transitionRow(orderId, "mark_ready");
    if (row.driver_id) {
      await this.notify(row.driver_id, row, "order_ready");
    }
    return this.withPackages(row);
  }

  async cancel(orderId: string): Promise<AdminOrderView> {
    const row = await this.transitionRow(orderId, "cancel");
    if (row.driver_id) {
      await this.notify(row.driver_id, row, "order_cancelled");
    }
    return this.withPackages(row);
  }

  private notify(
    driverId: string,
    row: OrderRow,
    type: DriverNotificationType,
  ): Promise<void> {
    return this.notifications.emit({
      driverId,
      orderId: row.id,
      type,
      deliveryDate: row.delivery_date,
      status: row.status,
    });
  }
}

/**
 * A cooler in the bags means the order needs a cooler bag, whatever the flag
 * said. The explicit flag still wins upward — an admin can require one before
 * the packages are entered — but adding a cooler package can never leave the
 * order marked as not needing one.
 */
function coolerBagRequired(
  explicit: boolean | undefined,
  packages: OrderPackageInput[],
): boolean {
  return (
    (explicit ?? false) || packages.some((p) => p.package_type === "cooler")
  );
}
