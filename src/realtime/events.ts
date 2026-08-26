import type { DriverNotificationType } from "../modules/notifications/repository.js";

/**
 * What the socket is allowed to say.
 *
 * PRD §7 names these events; the payload below is the part that matters.
 *
 * ## The socket carries a signal, not data
 *
 * Every order that reaches a driver's device goes through `toDriverOrderView`,
 * and that serializer is the whole enforcement of the PII_VISIBLE_STATUSES
 * cliff (docs/privacy-rules.md). A socket frame carrying an order would be a
 * second egress path around it — one with no serializer, no status check, and
 * no audit trail.
 *
 * So a frame says only *that* something changed, never *what*. The app reacts
 * by refetching GET /v1/driver/queue, which stays the only way an address ever
 * reaches a phone. Adding `patient_name` here to save a round-trip would
 * reintroduce exactly the leak the serializer exists to prevent.
 */

export type RealtimeEvent =
  | "order.assigned"
  | "order.ready"
  | "order.unassigned"
  | "order.cancelled";

/**
 * The complete frame. Three non-identifying fields: an opaque id, a calendar
 * date, and a status the driver is already entitled to see.
 *
 * Nothing derived from a `clients` row belongs here — not a name, not an
 * address, not a phone number.
 */
export interface RealtimeOrderPayload {
  order_id: string;
  delivery_date: string | null;
  status: string;
}

/**
 * The feed row types are snake_case because they are a database enum; the wire
 * events are dotted because PRD §7 named them that way. This map is the single
 * place the two vocabularies meet.
 */
export const SOCKET_EVENT: Record<DriverNotificationType, RealtimeEvent> = {
  order_assigned: "order.assigned",
  order_ready: "order.ready",
  order_unassigned: "order.unassigned",
  order_cancelled: "order.cancelled",
};

/** The room a driver's own events are published to. */
export function driverRoom(userId: string): string {
  return `user:${userId}`;
}
