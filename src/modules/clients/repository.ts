import { OrgScopedRepository } from "../../core/repository.js";
import type { Cursor } from "../../core/pagination.js";

export interface ClientRow {
  id: string;
  organization_id: string;
  name: string;
  address: string;
  phone_number: string;
  notes: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ClientListOptions {
  search?: string;
  isActive?: boolean;
  limit: number;
  cursor?: Cursor;
}

export class ClientsRepository extends OrgScopedRepository {
  protected readonly table = "clients";

  /**
   * Sorted by name so the saved-patient list reads alphabetically, which is
   * how staff scan it. Keyset pagination on (name, id) keeps the page stable
   * while other rows are being inserted.
   */
  async list(options: ClientListOptions): Promise<ClientRow[]> {
    const query = this.scoped()
      .select<ClientRow[]>("*")
      .orderBy([
        { column: "name", order: "asc" },
        { column: "id", order: "asc" },
      ])
      // One extra row tells the caller whether another page exists.
      .limit(options.limit + 1);

    if (options.isActive !== undefined) {
      query.where("is_active", options.isActive);
    }

    if (options.search) {
      const term = `%${options.search}%`;
      // Grouped deliberately: an ungrouped OR would sit alongside the
      // organization predicate and let another org's rows match.
      query.where((builder) => {
        builder.whereILike("name", term).orWhereILike("phone_number", term);
      });
    }

    if (options.cursor) {
      query.whereRaw("(clients.name, clients.id) > (?, ?)", [
        options.cursor.sortValue,
        options.cursor.id,
      ]);
    }

    return query;
  }

  async findById(id: string): Promise<ClientRow | undefined> {
    return this.scoped().where({ id }).first<ClientRow>();
  }

  async create(input: {
    name: string;
    address: string;
    phone_number: string;
    notes?: string | null;
  }): Promise<ClientRow> {
    const [row] = await this.unscoped()
      .insert({
        organization_id: this.organizationId,
        name: input.name,
        address: input.address,
        phone_number: input.phone_number,
        notes: input.notes ?? null,
      })
      .returning<ClientRow[]>("*");
    return row!;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<ClientRow, "name" | "address" | "phone_number" | "notes" | "is_active">
    >,
  ): Promise<ClientRow | undefined> {
    const [row] = await this.scoped()
      .where({ id })
      .update(patch)
      .returning<ClientRow[]>("*");
    return row;
  }

  /** Deletion is always soft — history references these rows. */
  async deactivate(id: string): Promise<ClientRow | undefined> {
    return this.update(id, { is_active: false });
  }

  async countOrders(clientId: string): Promise<number> {
    const row = await this.runner("orders")
      .where({ organization_id: this.organizationId, client_id: clientId })
      .count<{ count: string }>("* as count")
      .first();
    return Number(row?.count ?? 0);
  }
}
