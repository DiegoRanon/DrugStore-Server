import type { Knex } from "knex";

import { db, type QueryRunner } from "../db/knex.js";
import type { RequestContext } from "./context.js";

/**
 * Base class for every organization-owned table.
 *
 * PRD §4.4 requires org filtering "at the data-access layer, not per-route",
 * so that a forgotten WHERE clause is impossible. This is how that is made
 * true rather than merely intended:
 *
 *   - A repository cannot be constructed without a RequestContext.
 *   - `scoped()` is the only query entry point subclasses are given, and it
 *     always applies the organization predicate.
 *   - `unscoped()` exists for the few genuinely cross-org callers (the
 *     invoicing job, the retention purge) and is deliberately verbose,
 *     protected, and documented so its use stands out in review.
 *
 * Transactions are handled by constructing a second repository around the
 * transaction object — `new OrdersRepository(ctx, trx)` — rather than by
 * mutating state on a shared instance.
 */
export abstract class OrgScopedRepository {
  /** Physical table name. Used to qualify columns so joins stay unambiguous. */
  protected abstract readonly table: string;

  constructor(
    protected readonly ctx: RequestContext,
    protected readonly runner: QueryRunner = db,
  ) {}

  /**
   * Every read and write starts here. The organization predicate is applied
   * before the caller sees the builder, so it cannot be forgotten — only
   * deliberately bypassed via `unscoped()`.
   */
  protected scoped(): Knex.QueryBuilder {
    return this.runner(this.table).where(
      `${this.table}.organization_id`,
      this.ctx.organizationId,
    );
  }

  /**
   * Escape hatch for platform-level jobs that legitimately span organizations
   * (invoice generation, retention purges). Never reachable from a request
   * handler: those receive a RequestContext built from a user's token.
   */
  protected unscoped(): Knex.QueryBuilder {
    return this.runner(this.table);
  }

  /** Column reference qualified with the table name. */
  protected col(column: string): string {
    return `${this.table}.${column}`;
  }

  get organizationId(): string {
    return this.ctx.organizationId;
  }
}
