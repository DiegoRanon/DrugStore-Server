import type { OrderRow, OrderStatusEventRow } from "./repository.js";
import { isTerminal, type OrderStatus } from "./stateMachine.js";

/**
 * Separate response shapes for admin and driver contexts (PRD §8.3).
 *
 * The driver DTO is a union: once an order reaches a terminal state the
 * variant carrying `patient_name`, `address`, and `phone_number` is no longer
 * inhabited. Because driver routes are typed to return `DriverOrderView`,
 * leaking PII on a closed delivery is a compile error rather than something a
 * reviewer has to catch — which is what makes the control real, since a
 * client-side cache wipe is not enforcement.
 */

export interface AdminOrderView {
  id: string;
  client_id: string;
  driver_id: string | null;
  patient_name: string;
  address: string;
  phone_number: string;
  delivery_date: string;
  delivery_window: "AM" | "PM";
  status: OrderStatus;
  sequence_number: number | null;
  payment_status: "paid" | "unpaid";
  payment_collected: boolean;
  payment_method: "cash" | "card" | null;
  amount_due: number | null;
  amount_collected: number | null;
  requires_cooler_bag: boolean;
  cooler_bag_confirmed: boolean | null;
  picked_up_at: string | null;
  completed_at: string | null;
  returned_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields a driver may see while a delivery is still in progress. */
export interface ActiveDriverOrderView {
  id: string;
  status: "in_pharmacy" | "picked_up";
  sequence_number: number | null;
  delivery_date: string;
  delivery_window: "AM" | "PM";
  patient_name: string;
  address: string;
  phone_number: string;
  amount_due: number | null;
  payment_status: "paid" | "unpaid";
  payment_collected: boolean;
  requires_cooler_bag: boolean;
  picked_up_at: string | null;
}

/** A closed delivery: identifier, outcome, and timing only. */
export interface ClosedDriverOrderView {
  id: string;
  status: "completed" | "returned" | "cancelled";
  delivery_date: string;
  picked_up_at: string | null;
  completed_at: string | null;
  returned_at: string | null;
  requires_cooler_bag: boolean;
  cooler_bag_confirmed: boolean | null;
}

export type DriverOrderView = ActiveDriverOrderView | ClosedDriverOrderView;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function toAdminOrderView(row: OrderRow): AdminOrderView {
  return {
    id: row.id,
    client_id: row.client_id,
    driver_id: row.driver_id,
    patient_name: row.patient_name,
    address: row.address,
    phone_number: row.phone_number,
    delivery_date: row.delivery_date,
    delivery_window: row.delivery_window,
    status: row.status,
    sequence_number: row.sequence_number,
    payment_status: row.payment_status,
    payment_collected: row.payment_collected,
    payment_method: row.payment_method,
    amount_due: row.amount_due,
    amount_collected: row.amount_collected,
    requires_cooler_bag: row.requires_cooler_bag,
    cooler_bag_confirmed: row.cooler_bag_confirmed,
    picked_up_at: iso(row.picked_up_at),
    completed_at: iso(row.completed_at),
    returned_at: iso(row.returned_at),
    cancelled_at: iso(row.cancelled_at),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * The only way an order reaches a driver response. The terminal branch does
 * not read the PII columns at all, so they cannot be forwarded by accident.
 */
export function toDriverOrderView(row: OrderRow): DriverOrderView {
  if (isTerminal(row.status)) {
    return {
      id: row.id,
      status: row.status as ClosedDriverOrderView["status"],
      delivery_date: row.delivery_date,
      picked_up_at: iso(row.picked_up_at),
      completed_at: iso(row.completed_at),
      returned_at: iso(row.returned_at),
      requires_cooler_bag: row.requires_cooler_bag,
      cooler_bag_confirmed: row.cooler_bag_confirmed,
    };
  }

  return {
    id: row.id,
    status: row.status as ActiveDriverOrderView["status"],
    sequence_number: row.sequence_number,
    delivery_date: row.delivery_date,
    delivery_window: row.delivery_window,
    patient_name: row.patient_name,
    address: row.address,
    phone_number: row.phone_number,
    amount_due: row.amount_due,
    payment_status: row.payment_status,
    payment_collected: row.payment_collected,
    requires_cooler_bag: row.requires_cooler_bag,
    picked_up_at: iso(row.picked_up_at),
  };
}

export interface StatusEventView {
  status: OrderStatus;
  changed_by_user_id: string | null;
  occurred_at: string;
}

export function toStatusEventView(row: OrderStatusEventRow): StatusEventView {
  return {
    status: row.status,
    changed_by_user_id: row.changed_by_user_id,
    occurred_at: row.occurred_at.toISOString(),
  };
}
