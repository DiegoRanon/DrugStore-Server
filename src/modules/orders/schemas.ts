import { z } from "zod";

export const orderStatusSchema = z.enum([
  "in_pharmacy",
  "picked_up",
  "completed",
  "returned",
  "cancelled",
]);

export const deliveryWindowSchema = z.enum(["AM", "PM"]);

/** Calendar date, not a timestamp — a delivery day has no timezone. */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format");

const amountSchema = z
  .number()
  .nonnegative()
  .max(99_999_999.99)
  // NUMERIC(10,2) — reject extra precision at the edge rather than let
  // Postgres round it silently.
  .refine((v) => Number.isInteger(Math.round(v * 100)), {
    message: "Amount cannot have more than 2 decimal places",
  });

export const createOrderBodySchema = z.object({
  client_id: z.string().uuid(),
  driver_id: z.string().uuid().nullable().optional(),
  // Optional overrides; omitted fields are snapshotted from the client record.
  patient_name: z.string().trim().min(1).max(255).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  phone_number: z.string().trim().min(1).max(50).optional(),
  delivery_date: dateSchema,
  delivery_window: deliveryWindowSchema,
  payment_status: z.enum(["paid", "unpaid"]).optional(),
  amount_due: amountSchema.nullable().optional(),
  requires_cooler_bag: z.boolean().optional(),
});

export const updateOrderBodySchema = z
  .object({
    patient_name: z.string().trim().min(1).max(255).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    phone_number: z.string().trim().min(1).max(50).optional(),
    delivery_date: dateSchema.optional(),
    delivery_window: deliveryWindowSchema.optional(),
    payment_status: z.enum(["paid", "unpaid"]).optional(),
    amount_due: amountSchema.nullable().optional(),
    requires_cooler_bag: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });

export const assignDriverBodySchema = z.object({
  // null unassigns.
  driver_id: z.string().uuid().nullable(),
});

export const listOrdersQuerySchema = z.object({
  date: dateSchema.optional(),
  status: orderStatusSchema.optional(),
  driver_id: z.string().uuid().optional(),
  client_id: z.string().uuid().optional(),
  /** Polling fallback for when the WebSocket drops (PRD §7). */
  updated_since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

// --- responses -------------------------------------------------------------

export const orderResponseSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  driver_id: z.string().uuid().nullable(),
  patient_name: z.string(),
  address: z.string(),
  phone_number: z.string(),
  delivery_date: z.string(),
  delivery_window: deliveryWindowSchema,
  status: orderStatusSchema,
  sequence_number: z.number().nullable(),
  payment_status: z.enum(["paid", "unpaid"]),
  payment_collected: z.boolean(),
  payment_method: z.enum(["cash", "card"]).nullable(),
  amount_due: z.number().nullable(),
  amount_collected: z.number().nullable(),
  requires_cooler_bag: z.boolean(),
  cooler_bag_confirmed: z.boolean().nullable(),
  picked_up_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  returned_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const statusEventSchema = z.object({
  status: orderStatusSchema,
  changed_by_user_id: z.string().uuid().nullable(),
  occurred_at: z.string(),
});

export const orderDetailResponseSchema = orderResponseSchema.extend({
  status_events: z.array(statusEventSchema),
  available_transitions: z.array(
    z.enum(["pickup", "complete", "return", "cancel"]),
  ),
});

export const orderListResponseSchema = z.object({
  data: z.array(orderResponseSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
