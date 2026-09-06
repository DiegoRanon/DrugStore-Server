import type { Knex } from "knex";

import type { Cursor } from "../../core/pagination.js";
import { OrgScopedRepository } from "../../core/repository.js";
import type { QueryRunner } from "../../db/knex.js";
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  type OrderStatus,
  type TimestampColumn,
} from "./stateMachine.js";

export type DeliveryWindow = "AM" | "PM";
export type PaymentStatus = "paid" | "unpaid";
export type PaymentMethod = "cash" | "card";
export type PackageType = "bag" | "cooler" | "tote" | "envelope";
export type PaymentException = "waived_by_pharmacy" | "deferred_to_pharmacy";
export type DeliveryFailureReason =
  | "customer_absent"
  | "customer_refused"
  | "wrong_address"
  | "payment_refused"
  | "other";

export interface OrderRow {
  id: string;
  organization_id: string;
  driver_id: string | null;
  client_id: string;

  // Snapshot taken at insert time — never back-filled from the client record.
  patient_name: string;
  address: string;
  phone_number: string;
  authorized_recipient: string | null;

  /**
   * Geocode of `address`, snapshotted alongside it and for the same reason.
   * Null when the address was typed by hand rather than picked from Places —
   * such a stop is still delivered, it just cannot be routed, so it is
   * appended to the sequence rather than placed in it.
   *
   * PII, exactly as much as the address is. Active-stop responses only.
   */
  place_id: string | null;
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
  geocoded_at: Date | null;

  delivery_date: string;
  delivery_window: DeliveryWindow;
  /** Finer-grained ask than the window, when the pharmacy promised a time. */
  requested_delivery_time: string | null;
  /** An explicit interval — "between 2 and 4". Both ends or neither. */
  requested_time_start: string | null;
  requested_time_end: string | null;

  payment_status: PaymentStatus;
  payment_collected: boolean;
  payment_collected_at: Date | null;
  payment_method: PaymentMethod | null;
  amount_collected: number | null;
  amount_due: number | null;
  payment_exception: PaymentException | null;
  payment_exception_note: string | null;

  status: OrderStatus;
  is_priority: boolean;
  sequence_number: number | null;

  failure_reason: DeliveryFailureReason | null;
  failure_note: string | null;

  requires_cooler_bag: boolean;
  cooler_bag_confirmed: boolean | null;
  pickup_package_count: number | null;

  ready_at: Date | null;
  picked_up_at: Date | null;
  completed_at: Date | null;
  returned_at: Date | null;
  returned_to_pharmacy_at: Date | null;
  cancelled_at: Date | null;

  created_at: Date;
  updated_at: Date;
}

export interface OrderPackageRow {
  id: string;
  order_id: string;
  label_code: string;
  package_type: PackageType;
  position: number;
  created_at: Date;
}

export interface OrderStatusEventRow {
  id: string;
  order_id: string;
  status: OrderStatus;
  changed_by_user_id: string | null;
  occurred_at: Date;
}

export interface OrderListFilters {
  date?: string;
  from?: string;
  to?: string;
  status?: OrderStatus;
  driverId?: string;
  clientId?: string;
  isPriority?: boolean;
  updatedSince?: Date;
  limit: number;
  cursor?: Cursor;
}

export interface CalendarDayCount {
  delivery_date: string;
  status: OrderStatus;
  count: number;
}

export class OrdersRepository extends OrgScopedRepository {
  protected readonly table = "orders";

  /**
   * Organization scope plus the driver restriction from PRD §4.4: a driver
   * may only ever reach rows assigned to them. Applied here rather than in
   * the service so no query path can skip it.
   *
   * Drivers are additionally cut off from "scheduled" orders. The admin
   * calendar is admin-only until staff declare the order ready, and the state
   * machine refusing a pickup is not the same thing as the row being
   * unreachable — a pre-assigned order must not surface anywhere, including in
   * an error message that confirms it exists.
   */
  private actorScoped(): Knex.QueryBuilder {
    const query = this.scoped();
    if (this.ctx.role === "driver") {
      query
        .where(this.col("driver_id"), this.ctx.userId)
        .whereNot(this.col("status"), "scheduled");
    }
    return query;
  }

  async list(filters: OrderListFilters): Promise<OrderRow[]> {
    const query = this.actorScoped()
      .select<OrderRow[]>("orders.*")
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .limit(filters.limit + 1);

    if (filters.date) query.where(this.col("delivery_date"), filters.date);
    if (filters.from) query.where(this.col("delivery_date"), ">=", filters.from);
    if (filters.to) query.where(this.col("delivery_date"), "<=", filters.to);
    if (filters.status) query.where(this.col("status"), filters.status);
    if (filters.driverId) query.where(this.col("driver_id"), filters.driverId);
    if (filters.clientId) query.where(this.col("client_id"), filters.clientId);
    if (filters.isPriority !== undefined) {
      query.where(this.col("is_priority"), filters.isPriority);
    }
    if (filters.updatedSince) {
      query.where(this.col("updated_at"), ">", filters.updatedSince);
    }

    if (filters.cursor) {
      query.whereRaw("(orders.created_at, orders.id) < (?, ?)", [
        filters.cursor.sortValue,
        filters.cursor.id,
      ]);
    }

    return query;
  }

  /**
   * Per-day, per-status counts for the admin calendar.
   *
   * An aggregate rather than a page of orders: the calendar renders a month at
   * a time, and shipping every row would mean shipping a month of patient
   * addresses to draw some badges.
   */
  async countByDate(range: {
    from: string;
    to: string;
  }): Promise<CalendarDayCount[]> {
    const rows = (await this.scoped()
      .select("delivery_date", "status")
      .count("* as count")
      .where(this.col("delivery_date"), ">=", range.from)
      .where(this.col("delivery_date"), "<=", range.to)
      .groupBy("delivery_date", "status")
      .orderBy("delivery_date", "asc")) as unknown as {
      delivery_date: string;
      status: OrderStatus;
      count: string;
    }[];

    return rows.map((row) => ({
      delivery_date: row.delivery_date,
      status: row.status,
      count: Number(row.count),
    }));
  }

  async findById(id: string): Promise<OrderRow | undefined> {
    return this.actorScoped().where(this.col("id"), id).first<OrderRow>();
  }

  /**
   * Row-level lock for a status transition. Two drivers tapping "complete" on
   * the same order, or an admin cancelling while a driver picks up, must
   * serialize — otherwise both could read the same status and both write a
   * status event.
   */
  async findByIdForUpdate(
    id: string,
    trx: Knex.Transaction,
  ): Promise<OrderRow | undefined> {
    const query = trx(this.table)
      .where({ id, organization_id: this.organizationId })
      .forUpdate();

    if (this.ctx.role === "driver") {
      query.where("driver_id", this.ctx.userId).whereNot("status", "scheduled");
    }
    return query.first<OrderRow>();
  }

  async create(
    input: {
      client_id: string;
      driver_id?: string | null;
      patient_name: string;
      address: string;
      phone_number: string;
      authorized_recipient?: string | null;
      place_id?: string | null;
      formatted_address?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      geocoded_at?: Date | null;
      delivery_date: string;
      delivery_window: DeliveryWindow;
      requested_delivery_time?: string | null;
      requested_time_start?: string | null;
      requested_time_end?: string | null;
      payment_status: PaymentStatus;
      amount_due?: number | null;
      requires_cooler_bag: boolean;
      is_priority?: boolean;
      status: OrderStatus;
    },
    runner: QueryRunner = this.runner,
  ): Promise<OrderRow> {
    const [row] = await runner(this.table)
      .insert({ ...input, organization_id: this.organizationId })
      .returning<OrderRow[]>("*");
    return row!;
  }

  async update(
    id: string,
    patch: Partial<OrderRow>,
    runner: QueryRunner = this.runner,
  ): Promise<OrderRow | undefined> {
    const [row] = await runner(this.table)
      .where({ id, organization_id: this.organizationId })
      .update(patch)
      .returning<OrderRow[]>("*");
    return row;
  }

  /**
   * Writes the new status and its timestamp in a single UPDATE, then records
   * the audit event — both inside the caller's transaction, as PRD §5.3
   * requires.
   *
   * The optional patch rides along in the same statement so that outcome data
   * — why a delivery failed, what was collected at the door — cannot be
   * written a moment before or after the status it explains.
   */
  async applyTransition(
    trx: Knex.Transaction,
    input: {
      orderId: string;
      status: OrderStatus;
      timestampColumn: TimestampColumn;
      changedByUserId: string;
      patch?: Partial<OrderRow>;
    },
  ): Promise<OrderRow> {
    const [row] = await trx(this.table)
      .where({ id: input.orderId, organization_id: this.organizationId })
      .update({
        ...(input.patch ?? {}),
        status: input.status,
        [input.timestampColumn]: trx.fn.now(),
      })
      .returning<OrderRow[]>("*");

    await trx("order_status_events").insert({
      order_id: input.orderId,
      status: input.status,
      changed_by_user_id: input.changedByUserId,
    });

    return row!;
  }

  // --- driver queue ---------------------------------------------------------

  /**
   * A driver's active stops for a day, in route order.
   *
   * Priority first: "Si une commande doit être livrer prioritairement,
   * l'employé le dit au livreur maintenant." A stop the pharmacy flagged as
   * urgent has to survive whatever ordering the driver or the optimizer
   * chose, so it sorts ahead of the sequence rather than within it.
   *
   * sequence_number is nullable until the route is sequenced, so unsequenced
   * stops sort last rather than first — a NULL is "not yet placed", not
   * "position zero".
   */
  async listQueue(date: string, driverId?: string): Promise<OrderRow[]> {
    const query = this.actorScoped()
      .select<OrderRow[]>("orders.*")
      .where(this.col("delivery_date"), date)
      .whereIn(this.col("status"), [...ACTIVE_STATUSES])
      .orderByRaw(
        "orders.is_priority DESC, orders.sequence_number ASC NULLS LAST, orders.created_at ASC",
      );

    // Narrows an admin's org-wide view to one driver's day, which is the unit
    // a route is optimized in. Redundant but harmless for a driver caller —
    // actorScoped() has already pinned them to their own rows.
    if (driverId) query.where(this.col("driver_id"), driverId);

    return query;
  }

  /**
   * Failed deliveries still in the driver's van, awaiting the handover at the
   * pharmacy. Not "closed" — the driver still owes the pharmacy something.
   */
  async listAwaitingHandover(date: string): Promise<OrderRow[]> {
    return this.actorScoped()
      .select<OrderRow[]>("orders.*")
      .where(this.col("delivery_date"), date)
      .where(this.col("status"), "returned")
      .orderBy("returned_at", "asc");
  }

  /** Deliveries the driver finished with on that day, for the PII-free tail. */
  async listClosedForDate(date: string): Promise<OrderRow[]> {
    return this.actorScoped()
      .select<OrderRow[]>("orders.*")
      .where(this.col("delivery_date"), date)
      .whereIn(this.col("status"), [...TERMINAL_STATUSES])
      .orderBy("updated_at", "desc");
  }

  /** Most recent change to any of this driver's orders for a day. */
  async latestUpdateForDate(date: string): Promise<Date | null> {
    const row = await this.actorScoped()
      .max<{ max: Date | null }[]>("updated_at as max")
      .where(this.col("delivery_date"), date)
      .first();
    return row?.max ?? null;
  }

  /**
   * Rewrites the driver's route positions for a day.
   *
   * Cleared first, then reassigned: idx_orders_driver_date_sequence is a
   * non-deferrable unique index, so writing new positions over old ones in a
   * single pass would collide the moment two stops swap places.
   */
  async resequence(
    trx: Knex.Transaction,
    input: { driverId: string; date: string; orderedIds: string[] },
  ): Promise<void> {
    await trx(this.table)
      .where({
        organization_id: this.organizationId,
        driver_id: input.driverId,
        delivery_date: input.date,
      })
      .whereIn("status", [...ACTIVE_STATUSES])
      .update({ sequence_number: null });

    for (const [index, orderId] of input.orderedIds.entries()) {
      await trx(this.table)
        .where({ id: orderId, organization_id: this.organizationId })
        .update({ sequence_number: index + 1 });
    }
  }

  async recordPayment(
    id: string,
    input: {
      payment_method: PaymentMethod;
      amount_collected: number;
    },
    runner: QueryRunner = this.runner,
  ): Promise<OrderRow | undefined> {
    const query = runner(this.table).where({
      id,
      organization_id: this.organizationId,
    });
    if (this.ctx.role === "driver") {
      query.where("driver_id", this.ctx.userId);
    }

    const [row] = await query
      .update({
        payment_method: input.payment_method,
        amount_collected: input.amount_collected,
        payment_collected: true,
        payment_collected_at: runner.fn.now(),
        // The server owns keeping the business state consistent with the
        // driver's action; clients never write payment_status directly
        // outside order creation (PRD §5.5).
        payment_status: "paid",
      })
      .returning<OrderRow[]>("*");
    return row;
  }

  async recordCoolerCheck(
    id: string,
    confirmed: boolean,
  ): Promise<OrderRow | undefined> {
    const [row] = await this.actorScoped()
      .where(this.col("id"), id)
      .update({ cooler_bag_confirmed: confirmed })
      .returning<OrderRow[]>("*");
    return row;
  }

  async setPriority(
    id: string,
    isPriority: boolean,
  ): Promise<OrderRow | undefined> {
    const [row] = await this.actorScoped()
      .where(this.col("id"), id)
      .update({ is_priority: isPriority })
      .returning<OrderRow[]>("*");
    return row;
  }

  // --- packages -------------------------------------------------------------

  async listPackages(orderId: string): Promise<OrderPackageRow[]> {
    return this.runner<OrderPackageRow>("order_packages")
      .where({ order_id: orderId })
      .orderBy("position", "asc");
  }

  /**
   * Batch-loads packages for a page of orders, keyed by order id.
   *
   * The queue and the order list both render every stop's labels, so loading
   * them per order would put a query per stop on the driver's poll.
   */
  async listPackagesForOrders(
    orderIds: string[],
  ): Promise<Map<string, OrderPackageRow[]>> {
    const byOrder = new Map<string, OrderPackageRow[]>();
    if (orderIds.length === 0) return byOrder;

    const rows = await this.runner<OrderPackageRow>("order_packages")
      .whereIn("order_id", orderIds)
      .orderBy([
        { column: "order_id", order: "asc" },
        { column: "position", order: "asc" },
      ]);

    for (const row of rows) {
      const existing = byOrder.get(row.order_id);
      if (existing) existing.push(row);
      else byOrder.set(row.order_id, [row]);
    }
    return byOrder;
  }

  /**
   * Replaces an order's packages wholesale.
   *
   * Delete-then-insert rather than a diff: positions are a contiguous sequence
   * under a unique index, and reconciling them in place would have to sequence
   * its own writes to avoid transient collisions for no benefit — the list is
   * a handful of rows edited by one admin at a time.
   */
  async replacePackages(
    trx: Knex.Transaction,
    orderId: string,
    packages: { label_code: string; package_type?: PackageType }[],
  ): Promise<OrderPackageRow[]> {
    await trx("order_packages").where({ order_id: orderId }).delete();

    if (packages.length === 0) return [];

    return trx("order_packages")
      .insert(
        packages.map((pkg, index) => ({
          order_id: orderId,
          label_code: pkg.label_code,
          package_type: pkg.package_type ?? "bag",
          position: index + 1,
        })),
      )
      .returning<OrderPackageRow[]>("*");
  }

  async findOrganizationContact(): Promise<{
    name: string;
    phone: string | null;
    return_deadline: string | null;
  }> {
    const row = await this.runner("organizations")
      .select("name", "phone", "return_deadline")
      .where({ id: this.organizationId })
      .first();
    return row ?? { name: "", phone: null, return_deadline: null };
  }

  /**
   * Everything the route optimizer needs about the pharmacy itself: the
   * clock bounds behind AM/PM, the zone those bounds are stated in, and the
   * coordinate a route starts and ends at.
   *
   * Separate from findOrganizationContact() because that one feeds every
   * queue response and this one is read on optimize alone — the driver app
   * has no business receiving the org's window configuration on every poll.
   *
   * Falls back to the schema defaults rather than throwing. A missing
   * organizations row is not a thing that happens to a request that already
   * authenticated against one, and a route is more useful than a 500.
   */
  async findOrganizationRouting(): Promise<{
    timezone: string;
    am_window_start: string;
    am_window_end: string;
    pm_window_start: string;
    pm_window_end: string;
    latitude: number | null;
    longitude: number | null;
  }> {
    const row = await this.runner("organizations")
      .select(
        "timezone",
        "am_window_start",
        "am_window_end",
        "pm_window_start",
        "pm_window_end",
        "latitude",
        "longitude",
      )
      .where({ id: this.organizationId })
      .first();

    return {
      timezone: row?.timezone ?? "America/Toronto",
      am_window_start: row?.am_window_start ?? "09:00",
      am_window_end: row?.am_window_end ?? "12:00",
      pm_window_start: row?.pm_window_start ?? "13:00",
      pm_window_end: row?.pm_window_end ?? "17:00",
      latitude: row?.latitude ?? null,
      longitude: row?.longitude ?? null,
    };
  }

  async listStatusEvents(orderId: string): Promise<OrderStatusEventRow[]> {
    return this.runner<OrderStatusEventRow>("order_status_events")
      .where({ order_id: orderId })
      .orderBy("occurred_at", "asc");
  }

  /**
   * Confirms a driver exists, is active, and belongs to this organization.
   * Scoped explicitly — assignment is the one place an admin supplies a user
   * id from outside, so it must not be trusted.
   */
  async findAssignableDriver(
    driverId: string,
  ): Promise<{ id: string; first_name: string; last_name: string } | undefined> {
    return this.runner("users")
      .select("id", "first_name", "last_name")
      .where({
        id: driverId,
        organization_id: this.organizationId,
        role: "driver",
        is_active: true,
      })
      .first();
  }
}
