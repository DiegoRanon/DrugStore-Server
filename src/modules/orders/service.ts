import type { FastifyBaseLogger } from "fastify";

import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { buildPage, decodeCursor, type Page } from "../../core/pagination.js";
import { db } from "../../db/knex.js";
import { ClientsRepository } from "../clients/repository.js";
import {
  OrdersRepository,
  type DeliveryWindow,
  type OrderRow,
  type PaymentStatus,
} from "./repository.js";
import {
  toAdminOrderView,
  toStatusEventView,
  type AdminOrderView,
  type StatusEventView,
} from "./serializers.js";
import {
  assertTransitionAllowed,
  availableTransitions,
  isTerminal,
  TRANSITIONS,
  type OrderStatus,
  type TransitionName,
} from "./stateMachine.js";

export interface CreateOrderInput {
  client_id: string;
  driver_id?: string | null;
  patient_name?: string;
  address?: string;
  phone_number?: string;
  delivery_date: string;
  delivery_window: DeliveryWindow;
  payment_status?: PaymentStatus;
  amount_due?: number | null;
  requires_cooler_bag?: boolean;
}

export interface OrderDetailView extends AdminOrderView {
  status_events: StatusEventView[];
  available_transitions: TransitionName[];
}

export class OrdersService {
  private readonly repo: OrdersRepository;
  private readonly clients: ClientsRepository;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new OrdersRepository(ctx);
    this.clients = new ClientsRepository(ctx);
  }

  // --- creation ------------------------------------------------------------

  /**
   * Creates an order, snapshotting the client's logistics details onto it
   * (PRD §5.2).
   *
   * The snapshot is written once, here. There is deliberately no code path
   * anywhere that copies a client's current details onto an existing order —
   * editing a patient's address must never silently rewrite where last
   * month's delivery went.
   */
  async create(input: CreateOrderInput): Promise<AdminOrderView> {
    const client = await this.clients.findById(input.client_id);
    if (!client) throw new AppError("NOT_FOUND", "Client not found");

    if (!client.is_active) {
      throw new AppError(
        "CLIENT_INACTIVE",
        "This client is deactivated. Reactivate them before creating a delivery.",
      );
    }

    if (input.driver_id) {
      const driver = await this.repo.findAssignableDriver(input.driver_id);
      if (!driver) {
        throw new AppError(
          "NOT_FOUND",
          "Driver not found in this organization",
        );
      }
    }

    const row = await db.transaction(async (trx) => {
      const created = await this.repo.create(
        {
          client_id: client.id,
          driver_id: input.driver_id ?? null,
          // Caller-supplied values win, so an order can be corrected per
          // delivery ("apartment 4B this time") without touching the client.
          patient_name: input.patient_name ?? client.name,
          address: input.address ?? client.address,
          phone_number: input.phone_number ?? client.phone_number,
          delivery_date: input.delivery_date,
          delivery_window: input.delivery_window,
          payment_status: input.payment_status ?? "unpaid",
          amount_due: input.amount_due ?? null,
          requires_cooler_bag: input.requires_cooler_bag ?? false,
        },
        trx,
      );

      // The creation event, so order_status_events is a complete history
      // rather than one that starts at the first change.
      await trx("order_status_events").insert({
        order_id: created.id,
        status: created.status,
        changed_by_user_id: this.ctx.userId,
      });

      return created;
    });

    this.log.info(
      { order_id: row.id, client_id: client.id },
      "order created",
    );

    return toAdminOrderView(row);
  }

  // --- reads ---------------------------------------------------------------

  async list(options: {
    date?: string;
    status?: OrderStatus;
    driverId?: string;
    clientId?: string;
    updatedSince?: Date;
    limit: number;
    cursor?: string;
  }): Promise<Page<AdminOrderView>> {
    const rows = await this.repo.list({
      date: options.date,
      status: options.status,
      driverId: options.driverId,
      clientId: options.clientId,
      updatedSince: options.updatedSince,
      limit: options.limit,
      cursor: options.cursor ? decodeCursor(options.cursor) : undefined,
    });

    const page = buildPage(rows, options.limit, (row) => ({
      sortValue: row.created_at.toISOString(),
      id: row.id,
    }));

    return { ...page, data: page.data.map(toAdminOrderView) };
  }

  async get(id: string): Promise<OrderDetailView> {
    const row = await this.requireOrder(id);
    const events = await this.repo.listStatusEvents(id);

    return {
      ...toAdminOrderView(row),
      status_events: events.map(toStatusEventView),
      available_transitions: availableTransitions(row.status),
    };
  }

  private async requireOrder(id: string): Promise<OrderRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new AppError("NOT_FOUND", "Order not found");
    return row;
  }

  // --- edits ---------------------------------------------------------------

  /**
   * Editable only while the order is still at the pharmacy (PRD §5.2). Once a
   * driver holds the package, changing the address would mean the delivery
   * they are performing no longer matches the record of it.
   */
  async update(
    id: string,
    patch: {
      patient_name?: string;
      address?: string;
      phone_number?: string;
      delivery_date?: string;
      delivery_window?: DeliveryWindow;
      payment_status?: PaymentStatus;
      amount_due?: number | null;
      requires_cooler_bag?: boolean;
    },
  ): Promise<AdminOrderView> {
    const existing = await this.requireOrder(id);

    if (existing.status !== "in_pharmacy") {
      throw new AppError(
        "ORDER_NOT_EDITABLE",
        `An order can only be edited while it is in_pharmacy (this one is ${existing.status})`,
        { current_status: existing.status },
      );
    }

    const row = await this.repo.update(id, patch);
    if (!row) throw new AppError("NOT_FOUND", "Order not found");
    return toAdminOrderView(row);
  }

  /**
   * Assign or reassign a driver. Allowed at any non-terminal point, since
   * reassignment mid-route is a real dispatch need (PRD §12 Q6).
   */
  async assignDriver(
    id: string,
    driverId: string | null,
  ): Promise<AdminOrderView> {
    const existing = await this.requireOrder(id);

    if (isTerminal(existing.status)) {
      throw new AppError(
        "ORDER_ALREADY_TERMINAL",
        `Cannot reassign an order that is ${existing.status}`,
        { current_status: existing.status },
      );
    }

    if (driverId) {
      const driver = await this.repo.findAssignableDriver(driverId);
      if (!driver) {
        throw new AppError(
          "NOT_FOUND",
          "Driver not found in this organization",
        );
      }
    }

    const row = await this.repo.update(id, {
      driver_id: driverId,
      // The old driver's route position is meaningless to the new one, and
      // leaving it risks colliding with a position they already hold.
      sequence_number: null,
    });
    if (!row) throw new AppError("NOT_FOUND", "Order not found");

    this.log.info(
      {
        order_id: id,
        previous_driver_id: existing.driver_id,
        driver_id: driverId,
      },
      "order driver assignment changed",
    );

    return toAdminOrderView(row);
  }

  // --- state machine -------------------------------------------------------

  /**
   * The single path by which an order's status ever changes.
   *
   * Everything happens in one transaction: the row is locked, the transition
   * is validated against the current status, then the status, its timestamp,
   * and the audit event are written together. A caller cannot produce a
   * status without its timestamp or a change without its event.
   */
  async transitionRow(
    orderId: string,
    transitionName: TransitionName,
  ): Promise<OrderRow> {
    const definition = TRANSITIONS[transitionName];

    const row = await db.transaction(async (trx) => {
      const order = await this.repo.findByIdForUpdate(orderId, trx);
      if (!order) throw new AppError("NOT_FOUND", "Order not found");

      assertTransitionAllowed({
        transition: transitionName,
        currentStatus: order.status,
        actorRole: this.ctx.role,
        actorUserId: this.ctx.userId,
        assignedDriverId: order.driver_id,
      });

      return this.repo.applyTransition(trx, {
        orderId,
        status: definition.to,
        timestampColumn: definition.timestampColumn,
        changedByUserId: this.ctx.userId,
      });
    });

    this.log.info(
      {
        order_id: orderId,
        transition: transitionName,
        status: definition.to,
        actor_user_id: this.ctx.userId,
      },
      "order status changed",
    );

    return row;
  }

  /**
   * Admin-facing wrapper. Driver routes call `transitionRow` and apply the
   * driver serializer instead, so the same state machine serves both without
   * either context borrowing the other's response shape.
   */
  async transition(
    orderId: string,
    transitionName: TransitionName,
  ): Promise<AdminOrderView> {
    return toAdminOrderView(await this.transitionRow(orderId, transitionName));
  }

  cancel(orderId: string): Promise<AdminOrderView> {
    return this.transition(orderId, "cancel");
  }
}
