import { z } from "zod";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format");

/**
 * Response shapes mirror the two driver serializer variants: an active stop
 * carries patient details, a closed one carries none (PRD §8.3).
 */
const activeStopSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["in_pharmacy", "picked_up"]),
  sequence_number: z.number().nullable(),
  delivery_date: z.string(),
  delivery_window: z.enum(["AM", "PM"]),
  patient_name: z.string(),
  address: z.string(),
  phone_number: z.string(),
  amount_due: z.number().nullable(),
  payment_status: z.enum(["paid", "unpaid"]),
  payment_collected: z.boolean(),
  requires_cooler_bag: z.boolean(),
  picked_up_at: z.string().nullable(),
});

const closedStopSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["completed", "returned", "cancelled"]),
  delivery_date: z.string(),
  picked_up_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  returned_at: z.string().nullable(),
  requires_cooler_bag: z.boolean(),
  cooler_bag_confirmed: z.boolean().nullable(),
});

export const driverOrderSchema = z.union([activeStopSchema, closedStopSchema]);

export const queueResponseSchema = z.object({
  date: z.string(),
  pharmacy: z.object({ name: z.string(), phone: z.string().nullable() }),
  stops: z.array(driverOrderSchema),
  closed: z.array(closedStopSchema),
  degraded: z.boolean().optional(),
});

export const queueQuerySchema = z.object({
  // Defaults to today in the server's date, which the app overrides
  // explicitly when it needs a different day.
  date: dateSchema.optional(),
});

export const optimizeBodySchema = z.object({
  date: dateSchema.optional(),
  current_location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
});

export const paymentBodySchema = z.object({
  payment_method: z.enum(["cash", "card"]),
  amount_collected: z
    .number()
    .nonnegative()
    .max(99_999_999.99)
    .refine((v) => Number.isInteger(Math.round(v * 100)), {
      message: "Amount cannot have more than 2 decimal places",
    }),
});

export const paymentResponseSchema = z.object({
  order: driverOrderSchema,
  amount_due: z.number().nullable(),
  amount_collected: z.number(),
  matches_amount_due: z.boolean(),
});

export const coolerCheckBodySchema = z.object({
  confirmed: z.boolean(),
});
