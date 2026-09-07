import { db, type QueryRunner } from "../../db/knex.js";
import type { RequestContext } from "../../core/context.js";

export interface OrganizationRow {
  id: string;
  name: string;
  address: string | null;
  place_id: string | null;
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
  geocoded_at: Date | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  locale: string;
}

/** Columns the Settings page reads. Never `SELECT *` — this table also carries
 *  billing fields that have no business in a dashboard response. */
const COLUMNS = [
  "id",
  "name",
  "address",
  "place_id",
  "formatted_address",
  "latitude",
  "longitude",
  "geocoded_at",
  "phone",
  "email",
  "timezone",
  "locale",
] as const;

/**
 * The organization row itself.
 *
 * Not an `OrgScopedRepository`: that base filters on `organization_id`, and
 * this table's own key is `id`. The scoping rule still holds — every query
 * here is pinned to `ctx.organizationId`, so an admin can only ever read or
 * write their own pharmacy — it is just spelled differently.
 */
export class OrganizationsRepository {
  constructor(
    private readonly ctx: RequestContext,
    private readonly runner: QueryRunner = db,
  ) {}

  async find(): Promise<OrganizationRow | undefined> {
    return this.runner<OrganizationRow>("organizations")
      .select(...COLUMNS)
      .where({ id: this.ctx.organizationId })
      .first();
  }

  async update(
    patch: Partial<OrganizationRow>,
  ): Promise<OrganizationRow | undefined> {
    const [row] = await this.runner<OrganizationRow>("organizations")
      .where({ id: this.ctx.organizationId })
      .update(patch)
      .returning([...COLUMNS]);

    return row;
  }
}
