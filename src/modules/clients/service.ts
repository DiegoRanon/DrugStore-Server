import type { FastifyBaseLogger } from "fastify";

import { auditPiiRead } from "../../core/audit.js";
import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import {
  buildPage,
  decodeCursor,
  type Page,
} from "../../core/pagination.js";
import { ClientsRepository, type ClientRow } from "./repository.js";

export const COMPLIANCE_REMINDER =
  "Notes are for delivery logistics only. Do not record medical, pharmaceutical, or prescription information.";

export interface ClientView {
  id: string;
  name: string;
  address: string;
  phone_number: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  compliance_reminder?: string;
}

function toView(row: ClientRow): ClientView {
  const view: ClientView = {
    id: row.id,
    name: row.name,
    address: row.address,
    phone_number: row.phone_number,
    notes: row.notes,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
  if (row.notes && row.notes.length > 0) {
    view.compliance_reminder = COMPLIANCE_REMINDER;
  }
  return view;
}

export class ClientsService {
  private readonly repo: ClientsRepository;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new ClientsRepository(ctx);
  }

  /**
   * PRD §5.1 asks for a compliance warning whenever the notes field is used.
   * The note's *content* is never logged — that would move the very data we
   * are worried about into the log stream, which §8.6 forbids.
   */
  private warnOnNotes(clientId: string, notes: string | null | undefined): void {
    if (!notes || notes.length === 0) return;
    this.log.warn(
      {
        compliance: "client_notes_written",
        client_id: clientId,
        organization_id: this.ctx.organizationId,
        actor_user_id: this.ctx.userId,
        length: notes.length,
      },
      "free-text note written to a client record",
    );
  }

  async list(options: {
    search?: string;
    isActive?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Page<ClientView>> {
    const rows = await this.repo.list({
      search: options.search,
      isActive: options.isActive,
      limit: options.limit,
      cursor: options.cursor ? decodeCursor(options.cursor) : undefined,
    });

    const page = buildPage(rows, options.limit, (row) => ({
      sortValue: row.name,
      id: row.id,
    }));

    // Every row carries name, address, and phone_number (§8.4).
    await auditPiiRead(this.ctx, this.log, {
      action: "client.list.read",
      resourceType: "client",
      recordCount: page.data.length,
    });

    return { ...page, data: page.data.map(toView) };
  }

  async get(id: string): Promise<ClientView> {
    const row = await this.repo.findById(id);
    if (!row) throw new AppError("NOT_FOUND", "Client not found");

    await auditPiiRead(this.ctx, this.log, {
      action: "client.detail.read",
      resourceType: "client",
      resourceIds: [row.id],
    });

    return toView(row);
  }

  async create(input: {
    name: string;
    address: string;
    phone_number: string;
    notes?: string | null;
  }): Promise<ClientView> {
    const row = await this.repo.create(input);
    this.warnOnNotes(row.id, input.notes);
    return toView(row);
  }

  async update(
    id: string,
    patch: {
      name?: string;
      address?: string;
      phone_number?: string;
      notes?: string | null;
      is_active?: boolean;
    },
  ): Promise<ClientView> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new AppError("NOT_FOUND", "Client not found");

    const row = await this.repo.update(id, patch);
    if (!row) throw new AppError("NOT_FOUND", "Client not found");

    if (patch.notes !== undefined) this.warnOnNotes(id, patch.notes);
    return toView(row);
  }

  /**
   * Always a soft delete. `orders.client_id` is ON DELETE RESTRICT, so a row
   * with delivery history cannot be removed anyway — and even one without
   * history is deactivated rather than dropped, so the two cases behave
   * identically from the caller's point of view.
   */
  async deactivate(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new AppError("NOT_FOUND", "Client not found");

    if (!existing.is_active) return; // already inactive — idempotent

    await this.repo.deactivate(id);

    const orderCount = await this.repo.countOrders(id);
    this.log.info(
      { client_id: id, order_count: orderCount },
      "client deactivated",
    );
  }
}
