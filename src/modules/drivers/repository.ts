import type { Knex } from "knex";

import type { Cursor } from "../../core/pagination.js";
import { OrgScopedRepository } from "../../core/repository.js";

export interface DriverRow {
  id: string;
  organization_id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface DriverListOptions {
  search?: string;
  isActive?: boolean;
  limit: number;
  cursor?: Cursor;
}

/**
 * The organization's driver roster (MVP §6 "User Management").
 *
 * Backed by `users`, so every query needs the role predicate on top of the
 * organization one inherited from OrgScopedRepository — an admin listing
 * "drivers" must never see the org's admin row. `driversScoped()` is the only
 * entry point in this class for exactly that reason: the two predicates travel
 * together and cannot be applied by half.
 */
export class DriversRepository extends OrgScopedRepository {
  protected readonly table = "users";

  private driversScoped(): Knex.QueryBuilder {
    return this.scoped().where(this.col("role"), "driver");
  }

  /**
   * Sorted by last name, which is how staff scan a roster. Keyset pagination
   * on (last_name, id) matches the convention in ClientsRepository.
   */
  async list(options: DriverListOptions): Promise<DriverRow[]> {
    const query = this.driversScoped()
      .select<DriverRow[]>(
        "id",
        "organization_id",
        "email",
        "first_name",
        "last_name",
        "phone",
        "is_active",
        "created_at",
        "updated_at",
      )
      .orderBy([
        { column: "last_name", order: "asc" },
        { column: "id", order: "asc" },
      ])
      // Lookahead row: tells the caller whether another page exists.
      .limit(options.limit + 1);

    if (options.isActive !== undefined) {
      query.where("is_active", options.isActive);
    }

    if (options.search) {
      const term = `%${options.search}%`;
      // Grouped deliberately: an ungrouped OR would sit alongside the
      // organization and role predicates and let other rows match.
      query.where((builder) => {
        builder
          .whereILike("first_name", term)
          .orWhereILike("last_name", term)
          .orWhereILike("email", term);
      });
    }

    if (options.cursor) {
      query.whereRaw("(users.last_name, users.id) > (?, ?)", [
        options.cursor.sortValue,
        options.cursor.id,
      ]);
    }

    return query;
  }

  async findById(id: string): Promise<DriverRow | undefined> {
    return this.driversScoped().where({ id }).first<DriverRow>();
  }

  /**
   * Only `is_active` is patchable here. A driver's name, email, and password
   * are theirs to change through /v1/auth — an admin toggling employment
   * status must not become an admin editing someone's credentials.
   */
  async setActive(id: string, isActive: boolean): Promise<DriverRow | undefined> {
    const [row] = await this.driversScoped()
      .where({ id })
      .update({ is_active: isActive })
      .returning<DriverRow[]>([
        "id",
        "organization_id",
        "email",
        "first_name",
        "last_name",
        "phone",
        "is_active",
        "created_at",
        "updated_at",
      ]);
    return row;
  }

  /** Active-order count, surfaced when deactivating so work is not stranded. */
  async countActiveOrders(driverId: string): Promise<number> {
    const row = await this.runner("orders")
      .where({ organization_id: this.organizationId, driver_id: driverId })
      .whereIn("status", ["in_pharmacy", "picked_up"])
      .count<{ count: string }>("* as count")
      .first();
    return Number(row?.count ?? 0);
  }
}
