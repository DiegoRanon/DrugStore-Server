import type {
  DeliveryFailureReason,
  OrderPackageRow,
  OrderRow,
  OrderStatusEventRow,
  PaymentException,
} from "./repository.js";
import { showsPatientDetails, type OrderStatus } from "./stateMachine.js";

/**
 * Separate response shapes for admin and driver contexts.
 *
 * The driver DTO is a union: once a delivery attempt is over, the variant
 * carrying patient_name, address, phone_number, and authorized_recipient is no
 * longer inhabited. Because driver routes are typed to return DriverOrderView,
 * leaking PII on a closed delivery is a compile error rather than something a
 * reviewer has to catch — which is what makes the control real, since a
 * client-side cache wipe is not enforcement.
 *
 * The branch is on showsPatientDetails(), NOT on isTerminal(). Those two used
 * to agree; they no longer do. A "returned" order is not terminal — the driver
 * still owes the pharmacy a handover — but the delivery attempt is finished,
 * so the patient's details are gone from the moment it is marked failed.
 */

export interface OrderPackageView {
  id: string;
  label_code: string;
  package_type: "bag" | "cooler" | "tote" | "envelope";
  position: number;
}

export interface AdminOrderView {
  id: string;
  client_id: string;
  driver_id: string | null;
  patient_name: string;
  address: string;
  phone_number: string;
  authorized_recipient: string | null;
  delivery_date: string;
  delivery_window: "AM" | "PM";
  requested_delivery_time: string | null;
  status: OrderStatus;
  is_priority: boolean;
  sequence_number: number | null;
  payment_status: "paid" | "unpaid";
  payment_collected: boolean;
  payment_method: "cash" | "card" | null;
  amount_due: number | null;
  amount_collected: number | null;
  payment_exception: PaymentException | null;
  payment_exception_note: string | null;
  failure_reason: DeliveryFailureReason | null;
  failure_note: string | null;
  requires_cooler_bag: boolean;
  cooler_bag_confirmed: boolean | null;
  packages: OrderPackageView[];
  package_count: number;
  pickup_package_count: number | null;
  ready_at: string | null;
  picked_up_at: string | null;
  completed_at: string | null;
  returned_at: string | null;
  returned_to_pharmacy_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields a driver may see while a delivery is still in progress. */
export interface ActiveDriverOrderView {
  id: string;
  status: "in_pharmacy" | "picked_up";
  sequence_number: number | null;
  is_priority: boolean;
  delivery_date: string;
  delivery_window: "AM" | "PM";
  requested_delivery_time: string | null;
  patient_name: string;
  address: string;
  phone_number: string;
  /** Who may accept the package at the door (domain workflow, scénario A). */
  authorized_recipient: string | null;
  amount_due: number | null;
  payment_status: "paid" | "unpaid";
  payment_collected: boolean;
  requires_cooler_bag: boolean;
  /** Label codes to read against the physical bags at pickup. */
  packages: OrderPackageView[];
  package_count: number;
  picked_up_at: string | null;
}

/**
 * A delivery whose attempt is over: identifier, outcome, and timing only.
 *
 * Covers both terminal orders and a "returned" one still awaiting handover.
 * The driver needs the label codes to hand the right bags back, so those stay
 * — a label code is a bag number, not information about a person.
 */
export interface ClosedDriverOrderView {
  id: string;
  status: "completed" | "returned" | "returned_to_pharmacy" | "cancelled";
  delivery_date: string;
  failure_reason: DeliveryFailureReason | null;
  requires_cooler_bag: boolean;
  cooler_bag_confirmed: boolean | null;
  packages: OrderPackageView[];
  package_count: number;
  picked_up_at: string | null;
  completed_at: string | null;
  returned_at: string | null;
  returned_to_pharmacy_at: string | null;
}

export type DriverOrderView = ActiveDriverOrderView | ClosedDriverOrderView;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function toOrderPackageView(row: OrderPackageRow): OrderPackageView {
  return {
    id: row.id,
    label_code: row.label_code,
    package_type: row.package_type,
    position: row.position,
  };
}

export function toAdminOrderView(
  row: OrderRow,
  packages: OrderPackageRow[] = [],
): AdminOrderView {
  return {
    id: row.id,
    client_id: row.client_id,
    driver_id: row.driver_id,
    patient_name: row.patient_name,
    address: row.address,
    phone_number: row.phone_number,
    authorized_recipient: row.authorized_recipient,
    delivery_date: row.delivery_date,
    delivery_window: row.delivery_window,
    requested_delivery_time: row.requested_delivery_time,
    status: row.status,
    is_priority: row.is_priority,
    sequence_number: row.sequence_number,
    payment_status: row.payment_status,
    payment_collected: row.payment_collected,
    payment_method: row.payment_method,
    amount_due: row.amount_due,
    amount_collected: row.amount_collected,
    payment_exception: row.payment_exception,
    payment_exception_note: row.payment_exception_note,
    failure_reason: row.failure_reason,
    failure_note: row.failure_note,
    requires_cooler_bag: row.requires_cooler_bag,
    cooler_bag_confirmed: row.cooler_bag_confirmed,
    packages: packages.map(toOrderPackageView),
    package_count: packages.length,
    pickup_package_count: row.pickup_package_count,
    ready_at: iso(row.ready_at),
    picked_up_at: iso(row.picked_up_at),
    completed_at: iso(row.completed_at),
    returned_at: iso(row.returned_at),
    returned_to_pharmacy_at: iso(row.returned_to_pharmacy_at),
    cancelled_at: iso(row.cancelled_at),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * The only way an order reaches a driver response. The closed branch does not
 * read the PII columns at all, so they cannot be forwarded by accident.
 */
export function toDriverOrderView(
  row: OrderRow,
  packages: OrderPackageRow[] = [],
): DriverOrderView {
  const packageViews = packages.map(toOrderPackageView);

  if (!showsPatientDetails(row.status)) {
    return {
      id: row.id,
      status: row.status as ClosedDriverOrderView["status"],
      delivery_date: row.delivery_date,
      failure_reason: row.failure_reason,
      requires_cooler_bag: row.requires_cooler_bag,
      cooler_bag_confirmed: row.cooler_bag_confirmed,
      packages: packageViews,
      package_count: packageViews.length,
      picked_up_at: iso(row.picked_up_at),
      completed_at: iso(row.completed_at),
      returned_at: iso(row.returned_at),
      returned_to_pharmacy_at: iso(row.returned_to_pharmacy_at),
    };
  }

  return {
    id: row.id,
    status: row.status as ActiveDriverOrderView["status"],
    sequence_number: row.sequence_number,
    is_priority: row.is_priority,
    delivery_date: row.delivery_date,
    delivery_window: row.delivery_window,
    requested_delivery_time: row.requested_delivery_time,
    patient_name: row.patient_name,
    address: row.address,
    phone_number: row.phone_number,
    authorized_recipient: row.authorized_recipient,
    amount_due: row.amount_due,
    payment_status: row.payment_status,
    payment_collected: row.payment_collected,
    requires_cooler_bag: row.requires_cooler_bag,
    packages: packageViews,
    package_count: packageViews.length,
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
