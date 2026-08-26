import type { FastifyBaseLogger } from "fastify";

import type { RequestContext } from "../../core/context.js";
import { SOCKET_EVENT, getRealtime } from "../../realtime/index.js";
import {
  DriverNotificationsRepository,
  type DriverNotificationRow,
  type EmitNotificationInput,
} from "./repository.js";

/**
 * The driver's in-app feed.
 *
 * "Le livreur recoit une notification et la commande apparait dans la section
 *  en pharmacie" — and mid-shift, "le livreur ... reste à l'affut des commandes
 *  pouvant être ajouter par la pharmacie durant son shift."
 *
 * Two channels, one truth. The row is the durable record the app reads on
 * launch and in the feed screen; `getRealtime().toDriver()` is the live nudge
 * that saves the driver up to thirty seconds of polling for it (PRD §7).
 * The row is written first and the push is derived from it, so a driver who
 * was offline for the push still finds the notification waiting.
 */

export interface DriverNotificationView {
  id: string;
  type: DriverNotificationRow["type"];
  order_id: string | null;
  delivery_date: string | null;
  created_at: string;
  read_at: string | null;
}

function toView(row: DriverNotificationRow): DriverNotificationView {
  return {
    id: row.id,
    type: row.type,
    order_id: row.order_id,
    delivery_date: row.delivery_date,
    created_at: row.created_at.toISOString(),
    read_at: row.read_at?.toISOString() ?? null,
  };
}

export class NotificationsService {
  private readonly repo: DriverNotificationsRepository;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new DriverNotificationsRepository(ctx);
  }

  /**
   * Records that something changed for a driver, and tells them now.
   *
   * Fail-open, and called only after the order transaction has committed. A
   * notification is a courtesy on top of a fact that is already true — losing
   * one means a driver finds the order on their next poll instead of being
   * told about it, whereas failing the assignment because we could not write
   * the courtesy row would mean the dispatcher's actual work was rejected.
   * Same reasoning as the audit writer in src/core/audit.ts.
   *
   * The socket publish sits inside the same try for the same reason, and it is
   * the weaker of the two: a dropped frame costs the driver one poll interval,
   * while a Redis outage that propagated out of here would block assignment
   * across the whole pharmacy.
   *
   * Note what the payload does *not* carry — see src/realtime/events.ts. The
   * driver serializer is the only path patient data takes to a device.
   */
  async emit(input: EmitNotificationInput): Promise<void> {
    try {
      const row = await this.repo.insert(input);

      getRealtime().toDriver(input.driverId, SOCKET_EVENT[input.type], {
        order_id: input.orderId,
        delivery_date: row.delivery_date,
        status: input.status,
      });
    } catch (error) {
      this.log.error(
        {
          err: error,
          driver_id: input.driverId,
          order_id: input.orderId,
          notification_type: input.type,
        },
        "failed to record driver notification",
      );
    }
  }

  async list(options: {
    unreadOnly: boolean;
    limit: number;
  }): Promise<{ data: DriverNotificationView[]; unread_count: number }> {
    const [rows, unread] = await Promise.all([
      this.repo.listForDriver({
        driverId: this.ctx.userId,
        unreadOnly: options.unreadOnly,
        limit: options.limit,
      }),
      this.repo.countUnread(this.ctx.userId),
    ]);

    return { data: rows.map(toView), unread_count: unread };
  }

  async markRead(ids?: string[]): Promise<{ updated: number }> {
    const updated = await this.repo.markRead(this.ctx.userId, ids);
    return { updated };
  }

  countUnread(): Promise<number> {
    return this.repo.countUnread(this.ctx.userId);
  }
}
