import { z } from "zod";

export const orderStatusSchema = z.enum([
  "scheduled",
  "in_pharmacy",
  "picked_up",
  "completed",
  "returned",
  "returned_to_pharmacy",
  "cancelled",
]);

export const transitionNameSchema = z.enum([
  "mark_ready",
  "pickup",
  "complete",
  "return",
  "handover",
  "cancel",
]);

export const deliveryWindowSchema = z.enum(["AM", "PM"]);

export const packageTypeSchema = z.enum(["bag", "cooler", "tote", "envelope"]);

export const failureReasonSchema = z.enum([
  "customer_absent",
  "customer_refused",
  "wrong_address",
  "payment_refused",
  "other",
]);

export const paymentExceptionSchema = z.enum([
  "waived_by_pharmacy",
  "deferred_to_pharmacy",
]);

/** Calendar date, not a timestamp — a delivery day has no timezone. */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format");

/** Local wall-clock time in the organization's timezone. */
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Must be a time in HH:MM format");

const amountSchema = z
  .number()
  .nonnegative()
  .max(99_999_999.99)
  // NUMERIC(10,2) — reject extra precision at the edge rather than let
  // Postgres round it silently.
  .refine((v) => Number.isInteger(Math.round(v * 100)), {
    message: "Amount cannot have more than 2 decimal places",
  });

/**
 * A physical parcel, for label verification at pickup.
 *
 * Note what is absent: there is no description or free-text field, because the
 * product constraint forbids storing prescription or medical information and a
 * free-text line item is exactly where a medication name would end up. A label
 * code is what is printed on the bag.
 */
export const orderPackageInputSchema = z.object({
  label_code: z.string().trim().min(1).max(32),
  package_type: packageTypeSchema.optional(),
});

const packageListSchema = z
  .array(orderPackageInputSchema)
  .max(50)
  .superRefine((packages, ctx) => {
    const seen = new Set<string>();
    for (const pkg of packages) {
      const key = pkg.label_code.toUpperCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate label code: ${pkg.label_code}`,
        });
      }
      seen.add(key);
    }
  });

export const createOrderBodySchema = z.object({
  client_id: z.string().uuid(),
  driver_id: z.string().uuid().nullable().optional(),
  // Optional overrides; omitted fields are snapshotted from the client record.
  patient_name: z.string().trim().min(1).max(255).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  phone_number: z.string().trim().min(1).max(50).optional(),
  authorized_recipient: z.string().trim().min(1).max(255).nullable().optional(),
  delivery_date: dateSchema,
  delivery_window: deliveryWindowSchema,
  requested_delivery_time: timeSchema.nullable().optional(),
  payment_status: z.enum(["paid", "unpaid"]).optional(),
  amount_due: amountSchema.nullable().optional(),
  requires_cooler_bag: z.boolean().optional(),
  is_priority: z.boolean().optional(),
  packages: packageListSchema.optional(),
});

export const updateOrderBodySchema = z
  .object({
    patient_name: z.string().trim().min(1).max(255).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    phone_number: z.string().trim().min(1).max(50).optional(),
    authorized_recipient: z.string().trim().min(1).max(255).nullable().optional(),
    delivery_date: dateSchema.optional(),
    delivery_window: deliveryWindowSchema.optional(),
    requested_delivery_time: timeSchema.nullable().optional(),
    payment_status: z.enum(["paid", "unpaid"]).optional(),
    amount_due: amountSchema.nullable().optional(),
    requires_cooler_bag: z.boolean().optional(),
    is_priority: z.boolean().optional(),
    packages: packageListSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });

export const assignDriverBodySchema = z.object({
  // null unassigns.
  driver_id: z.string().uuid().nullable(),
});

export const setPriorityBodySchema = z.object({
  is_priority: z.boolean(),
});

export const listOrdersQuerySchema = z
  .object({
    date: dateSchema.optional(),
    /** Inclusive range, for the calendar and for multi-day boards. */
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    status: orderStatusSchema.optional(),
    driver_id: z.string().uuid().optional(),
    client_id: z.string().uuid().optional(),
    is_priority: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    /** Polling fallback for when the WebSocket drops (PRD §7). */
    updated_since: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: "from must not be after to",
  });

export const calendarQuerySchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
  })
  .refine((q) => q.from <= q.to, { message: "from must not be after to" });

// --- responses -------------------------------------------------------------

export const orderPackageSchema = z.object({
  id: z.string().uuid(),
  label_code: z.string(),
  package_type: packageTypeSchema,
  position: z.number(),
});

export const orderResponseSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  driver_id: z.string().uuid().nullable(),
  patient_name: z.string(),
  address: z.string(),
  phone_number: z.string(),
  authorized_recipient: z.string().nullable(),
  delivery_date: z.string(),
  delivery_window: deliveryWindowSchema,
  requested_delivery_time: z.string().nullable(),
  status: orderStatusSchema,
  is_priority: z.boolean(),
  sequence_number: z.number().nullable(),
  payment_status: z.enum(["paid", "unpaid"]),
  payment_collected: z.boolean(),
  payment_method: z.enum(["cash", "card"]).nullable(),
  amount_due: z.number().nullable(),
  amount_collected: z.number().nullable(),
  payment_exception: paymentExceptionSchema.nullable(),
  payment_exception_note: z.string().nullable(),
  failure_reason: failureReasonSchema.nullable(),
  failure_note: z.string().nullable(),
  requires_cooler_bag: z.boolean(),
  cooler_bag_confirmed: z.boolean().nullable(),
  packages: z.array(orderPackageSchema),
  package_count: z.number(),
  pickup_package_count: z.number().nullable(),
  ready_at: z.string().nullable(),
  picked_up_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  returned_at: z.string().nullable(),
  returned_to_pharmacy_at: z.string().nullable(),
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
  available_transitions: z.array(transitionNameSchema),
});

export const orderListResponseSchema = z.object({
  data: z.array(orderResponseSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const calendarResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: z.array(
    z.object({
      delivery_date: z.string(),
      total: z.number(),
      by_status: z.record(orderStatusSchema, z.number()),
    }),
  ),
});
