import type { Knex } from "knex";

import type { Cursor } from "../../core/pagination.js";
import { OrgScopedRepository } from "../../core/repository.js";
import type { QueryRunner } from "../../db/knex.js";
import type { OrderStatus, TimestampColumn } from "./stateMachine.js";

export type DeliveryWindow = "AM" | "PM";
export type PaymentStatus = "paid" | "unpaid";
export type PaymentMethod = "cash" | "card";

export interface OrderRow {
  id: string;
  organization_id: string;
  driver_id: string | null;
  client_id: string;

  // Snapshot taken at insert time — never back-filled from the client record.
  patient_name: string;
  address: string;
  phone_number: string;

  delivery_date: string;
  delivery_window: DeliveryWindow;

  payment_status: PaymentStatus;
  payment_collected: boolean;
  payment_collected_at: Date | null;
  payment_method: PaymentMethod | null;
  amount_collected: number | null;
  amount_due: number | null;

  status: OrderStatus;
  sequence_number: number | null;

  requires_cooler_bag: boolean;
  cooler_bag_confirmed: boolean | null;

  picked_up_at: Date | null;
  completed_at: Date | null;
  returned_at: Date | null;
  cancelled_at: Date | null;

  created_at: Date;
  updated_at: Date;
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
  status?: OrderStatus;
  driverId?: string;
  clientId?: string;
  updatedSince?: Date;
  limit: number;
  cursor?: Cursor;
}

export class OrdersRepository extends OrgScopedRepository {
  protected readonly table = "orders";

  /**
   * Organization scope plus the driver restriction from PRD §4.4: a driver
   * may only ever reach rows assigned to them. Applied here rather than in
   * the service so no query path can skip it.
   */
  private actorScoped(): Knex.QueryBuilder {
    const query = this.scoped();
    if (this.ctx.role === "driver") {
      query.where(this.col("driver_id"), this.ctx.userId);
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
    if (filters.status) query.where(this.col("status"), filters.status);
    if (filters.driverId) query.where(this.col("driver_id"), filters.driverId);
    if (filters.clientId) query.where(this.col("client_id"), filters.clientId);
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

  async findById(id: string): Promise<OrderRow | undefined> {
    return this.actorScoped().where(this.col("id"), id).first<OrderRow>();
  }

  /**
   * Row-level lock for a status transition. Two drivers tapping "complete" on
   * the same order, or an admin cancelling while a driver picks up, must
   * serialize — otherwise both could read `in_pharmacy` and both write a
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
      query.where("driver_id", this.ctx.userId);
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
      delivery_date: string;
      delivery_window: DeliveryWindow;
      payment_status: PaymentStatus;
      amount_due?: number | null;
      requires_cooler_bag: boolean;
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
  ): Promise<OrderRow | undefined> {
    const [row] = await this.scoped()
      .where(this.col("id"), id)
      .update(patch)
      .returning<OrderRow[]>("*");
    return row;
  }

  /**
   * Writes the new status and its timestamp in a single UPDATE, then records
   * the audit event — both inside the caller's transaction, as PRD §5.3
   * requires.
   */
  async applyTransition(
    trx: Knex.Transaction,
    input: {
      orderId: string;
      status: OrderStatus;
      timestampColumn: TimestampColumn;
      changedByUserId: string;
    },
  ): Promise<OrderRow> {
    const [row] = await trx(this.table)
      .where({ id: input.orderId, organization_id: this.organizationId })
      .update({
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

  /**
   * A driver's active stops for a day, in route order.
   *
   * `sequence_number` is nullable until the route is optimized, so unsequenced
   * stops sort last rather than first — a NULL is "not yet placed", not
   * "position zero".
   */
  async listQueue(date: string): Promise<OrderRow[]> {
    return this.actorScoped()
      .select<OrderRow[]>("orders.*")
      .where(this.col("delivery_date"), date)
      .whereIn(this.col("status"), ["in_pharmacy", "picked_up"])
      .orderByRaw("orders.sequence_number ASC NULLS LAST, orders.created_at ASC");
  }

  /** Deliveries the driver already closed on that day, for the PII-free tail. */
  async listClosedForDate(date: string): Promise<OrderRow[]> {
    return this.actorScoped()
      .select<OrderRow[]>("orders.*")
      .where(this.col("delivery_date"), date)
      .whereIn(this.col("status"), ["completed", "returned", "cancelled"])
      .orderBy("updated_at", "desc");
  }

  /**
   * Rewrites the driver's route positions for a day.
   *
   * Cleared first, then reassigned: `idx_orders_driver_date_sequence` is a
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
      .whereIn("status", ["in_pharmacy", "picked_up"])
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
  ): Promise<OrderRow | undefined> {
    const [row] = await this.actorScoped()
      .where(this.col("id"), id)
      .update({
        payment_method: input.payment_method,
        amount_collected: input.amount_collected,
        payment_collected: true,
        payment_collected_at: this.runner.fn.now(),
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

  async findOrganizationContact(): Promise<{
    name: string;
    phone: string | null;
  }> {
    const row = await this.runner("organizations")
      .select("name", "phone")
      .where({ id: this.organizationId })
      .first();
    return row ?? { name: "", phone: null };
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
