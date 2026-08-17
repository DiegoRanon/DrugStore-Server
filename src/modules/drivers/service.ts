import type { FastifyBaseLogger } from "fastify";

import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { buildPage, decodeCursor, type Page } from "../../core/pagination.js";
import { AuthRepository } from "../auth/repository.js";
import { DriversRepository, type DriverRow } from "./repository.js";

export interface DriverView {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DriverStatusView extends DriverView {
  active_order_count: number;
}

function toView(row: DriverRow): DriverView {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Driver roster management (MVP §6). Admin-facing: the dashboard needs this to
 * resolve `orders.driver_id` to a name and to populate the assign dropdown.
 */
export class DriversService {
  private readonly repo: DriversRepository;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new DriversRepository(ctx);
  }

  async list(options: {
    search?: string;
    isActive?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Page<DriverView>> {
    const rows = await this.repo.list({
      search: options.search,
      isActive: options.isActive,
      limit: options.limit,
      cursor: options.cursor ? decodeCursor(options.cursor) : undefined,
    });

    const page = buildPage(rows, options.limit, (row) => ({
      sortValue: row.last_name,
      id: row.id,
    }));

    return { ...page, data: page.data.map(toView) };
  }

  async get(id: string): Promise<DriverView> {
    const row = await this.repo.findById(id);
    if (!row) throw new AppError("NOT_FOUND", "Driver not found");
    return toView(row);
  }

  /**
   * Toggles employment status.
   *
   * Deactivation revokes every refresh token the driver holds. Without that,
   * clearing `is_active` only stops *new* logins — the existing session stays
   * valid until its access token expires and then refreshes cleanly for up to
   * REFRESH_TOKEN_TTL_DAYS. A driver who has been let go would keep patient
   * addresses on their phone for a month.
   */
  async setActive(id: string, isActive: boolean): Promise<DriverStatusView> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new AppError("NOT_FOUND", "Driver not found");

    const row = existing.is_active === isActive
      ? existing
      : ((await this.repo.setActive(id, isActive)) ?? existing);

    if (!isActive && existing.is_active) {
      const revoked = await new AuthRepository().revokeAllForUser(
        id,
        "user_deactivated",
      );
      this.log.info(
        {
          driver_id: id,
          organization_id: this.ctx.organizationId,
          actor_user_id: this.ctx.userId,
          revoked_sessions: revoked,
        },
        "driver deactivated",
      );
    }

    const activeOrderCount = await this.repo.countActiveOrders(id);

    // Deactivating with deliveries still open is allowed but worth a warning:
    // those orders keep their driver_id and need reassigning.
    if (!isActive && activeOrderCount > 0) {
      this.log.warn(
        { driver_id: id, active_order_count: activeOrderCount },
        "driver deactivated with active orders still assigned",
      );
    }

    return { ...toView(row), active_order_count: activeOrderCount };
  }
}
