import { OrgScopedRepository } from "../../core/repository.js";

export type DriverNotificationType =
  | "order_assigned"
  | "order_ready"
  | "order_unassigned"
  | "order_cancelled";

export interface DriverNotificationRow {
  id: string;
  organization_id: string;
  driver_id: string;
  order_id: string | null;
  type: DriverNotificationType;
  delivery_date: string | null;
  created_at: Date;
  read_at: Date | null;
}

export interface EmitNotificationInput {
  driverId: string;
  orderId: string;
  type: DriverNotificationType;
  deliveryDate: string;
}

export class DriverNotificationsRepository extends OrgScopedRepository {
  protected readonly table = "driver_notifications";

  async insert(input: EmitNotificationInput): Promise<DriverNotificationRow> {
    const [row] = await this.runner(this.table)
      .insert({
        organization_id: this.organizationId,
        driver_id: input.driverId,
        order_id: input.orderId,
        type: input.type,
        delivery_date: input.deliveryDate,
      })
      .returning<DriverNotificationRow[]>("*");
    return row!;
  }

  /**
   * One driver's feed, newest first.
   *
   * Always filtered to the caller — the org predicate from the base class is
   * not enough here, since every driver in a pharmacy shares an organization.
   */
  async listForDriver(options: {
    driverId: string;
    unreadOnly: boolean;
    limit: number;
  }): Promise<DriverNotificationRow[]> {
    const query = this.scoped()
      .select<DriverNotificationRow[]>("driver_notifications.*")
      .where(this.col("driver_id"), options.driverId)
      .orderBy("created_at", "desc")
      .limit(options.limit);

    if (options.unreadOnly) query.whereNull(this.col("read_at"));
    return query;
  }

  async countUnread(driverId: string): Promise<number> {
    const row = await this.scoped()
      .where(this.col("driver_id"), driverId)
      .whereNull(this.col("read_at"))
      .count<{ count: string }[]>("* as count")
      .first();
    return Number(row?.count ?? 0);
  }

  /** Marks the given notifications read, or every unread one when ids is empty. */
  async markRead(driverId: string, ids?: string[]): Promise<number> {
    const query = this.scoped()
      .where(this.col("driver_id"), driverId)
      .whereNull(this.col("read_at"));

    if (ids && ids.length > 0) query.whereIn(this.col("id"), ids);

    return query.update({ read_at: this.runner.fn.now() });
  }
}
