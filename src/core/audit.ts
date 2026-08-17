import type { FastifyBaseLogger } from "fastify";

import { db, type QueryRunner } from "../db/knex.js";
import type { RequestContext } from "./context.js";

/**
 * The `auditPiiRead()` helper named in migration 007's table comment.
 *
 * Law 25 accountability (PRD §8.4) requires knowing who read personal
 * information, not just who changed it — `order_status_events` covers changes
 * only. Every admin read that returns patient names, addresses, or phone
 * numbers lands a row in the append-only `access_audit_log`.
 *
 * Scope is deliberately admin reads. A driver polling their own queue every
 * 15s would bury the trail in operational noise, and §8.3 already constrains
 * what a driver can see to the delivery they are actively performing.
 */

/** Stable vocabulary — these strings are what an auditor will query on. */
export type AuditAction =
  | "order.list.read"
  | "order.detail.read"
  | "client.list.read"
  | "client.detail.read";

export type AuditResourceType = "order" | "client";

export interface AuditPiiReadInput {
  action: AuditAction;
  resourceType: AuditResourceType;
  /**
   * Specific rows, for bounded reads only. A 200-row list page would put 200
   * UUIDs in a single row for little forensic gain, so lists pass
   * `recordCount` instead — matching the column comments in migration 007.
   */
  resourceIds?: string[];
  /** Scope size, for list and export reads. */
  recordCount?: number;
}

/** `user_agent` is VARCHAR(255); browsers routinely send longer. */
const USER_AGENT_MAX = 255;

/**
 * Writes one audit row. Never throws.
 *
 * Fail-open is a deliberate trade-off: an audit-table problem must not turn a
 * pharmacist's order lookup into a 500, in keeping with the PRD's stance that
 * dependency failures never block operations. The compensating control is
 * volume — the failure is logged at `error` with the full context that would
 * have been persisted, so the trail is recoverable from the log stream and the
 * gap is loud rather than silent.
 */
export async function auditPiiRead(
  ctx: RequestContext,
  log: FastifyBaseLogger,
  input: AuditPiiReadInput,
  runner: QueryRunner = db,
): Promise<void> {
  const row = {
    actor_user_id: ctx.userId,
    actor_role: ctx.role,
    organization_id: ctx.organizationId,
    action: input.action,
    resource_type: input.resourceType,
    resource_ids: input.resourceIds ?? null,
    record_count: input.recordCount ?? input.resourceIds?.length ?? null,
    ip_address: ctx.ipAddress,
    user_agent: ctx.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
    request_id: ctx.requestId,
  };

  try {
    await runner("access_audit_log").insert(row);
  } catch (error) {
    log.error(
      { err: error, audit: row, compliance: "audit_write_failed" },
      "failed to record PII access in access_audit_log",
    );
  }
}
