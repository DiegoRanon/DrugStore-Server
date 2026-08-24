import { z } from "zod";

import {
  failureReasonSchema,
  orderPackageSchema,
  paymentExceptionSchema,
} from "../orders/schemas.js";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format");

const amountSchema = z
  .number()
  .nonnegative()
  .max(99_999_999.99)
  .refine((v) => Number.isInteger(Math.round(v * 100)), {
    message: "Amount cannot have more than 2 decimal places",
  });

/**
 * Response shapes mirror the two driver serializer variants: an active stop
 * carries patient details, a stop whose delivery attempt is over carries none.
 *
 * Note that "returned" is a closed stop even though it is not terminal. The
 * package is still in the driver's van awaiting handover, but the attempt is
 * finished, so the address and phone number are gone.
 */
const activeStopSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["in_pharmacy", "picked_up"]),
  sequence_number: z.number().nullable(),
  is_priority: z.boolean(),
  delivery_date: z.string(),
  delivery_window: z.enum(["AM", "PM"]),
  requested_delivery_time: z.string().nullable(),
  patient_name: z.string(),
  address: z.string(),
  phone_number: z.string(),
  authorized_recipient: z.string().nullable(),
  amount_due: z.number().nullable(),
  payment_status: z.enum(["paid", "unpaid"]),
  payment_collected: z.boolean(),
  requires_cooler_bag: z.boolean(),
  packages: z.array(orderPackageSchema),
  package_count: z.number(),
  picked_up_at: z.string().nullable(),
});

const closedStopSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "completed",
    "returned",
    "returned_to_pharmacy",
    "cancelled",
  ]),
  delivery_date: z.string(),
  failure_reason: failureReasonSchema.nullable(),
  requires_cooler_bag: z.boolean(),
  cooler_bag_confirmed: z.boolean().nullable(),
  packages: z.array(orderPackageSchema),
  package_count: z.number(),
  picked_up_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  returned_at: z.string().nullable(),
  returned_to_pharmacy_at: z.string().nullable(),
});

export const driverOrderSchema = z.union([activeStopSchema, closedStopSchema]);

/**
 * Per-stop travel estimates.
 *
 * The driver routes manually — "Le livreur détermine manuellement l'itinéraire
 * le plus rapide ... en tenant compte de l'estimation de distance faite par
 * l'application" — so these inform a decision rather than making one. Null
 * when the configured optimizer cannot estimate; a fabricated number would be
 * worse than an honest absence.
 */
const stopEstimateSchema = z.object({
  order_id: z.string().uuid(),
  distance_meters: z.number().nullable(),
  duration_seconds: z.number().nullable(),
});

export const queueResponseSchema = z.object({
  date: z.string(),
  pharmacy: z.object({
    name: z.string(),
    phone: z.string().nullable(),
    /** "Le livreur retourne en pharmacie avant une certaine heure limite." */
    return_deadline: z.string().nullable(),
  }),
  stops: z.array(driverOrderSchema),
  /** Failed deliveries still in the van, owed back to the pharmacy. */
  to_return: z.array(closedStopSchema),
  closed: z.array(closedStopSchema),
  totals: z.object({
    stop_count: z.number(),
    priority_count: z.number(),
    /** How many stops still owe money at the door. */
    payment_stop_count: z.number(),
    amount_due_total: z.number(),
    /** Whether to take the physical POS terminal from the pharmacy. */
    requires_payment_terminal: z.boolean(),
    packages_to_return: z.number(),
  }),
  estimates: z.array(stopEstimateSchema).optional(),
  unread_notifications: z.number(),
  /** True when anything changed since the updated_since the caller passed. */
  has_new: z.boolean(),
  last_updated_at: z.string().nullable(),
  degraded: z.boolean().optional(),
});

export const queueQuerySchema = z.object({
  // Defaults to today in the server's date, which the app overrides
  // explicitly when it needs a different day.
  date: dateSchema.optional(),
  /** Poll cursor: the last_updated_at from the previous queue response. */
  updated_since: z.coerce.date().optional(),
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

/** Manual reordering — the driver's own route, not the optimizer's. */
export const sequenceBodySchema = z.object({
  date: dateSchema.optional(),
  ordered_order_ids: z.array(z.string().uuid()).min(1).max(200),
});

/**
 * Fastify hands the validator an explicit `null` when a POST arrives with no
 * body at all, which several of these actions legitimately do — a one-tap
 * pickup or completion has nothing to say.
 *
 * z.preprocess rather than .nullish(): a nullish body renders in the published
 * OpenAPI as `anyOf: [{not: {}}, {...}]`, which the dashboard's
 * openapi-typescript generator turns into an unusable type. A preprocess step
 * is invisible to the generated schema, so the contract stays a plain object.
 */
const emptyBodyAsObject = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value ?? {}, schema);

export const pickupBodySchema = emptyBodyAsObject(
  z.object({
    /**
     * What the driver counted while checking labels with the employee. The
     * digital trace of "en vérifiant que les étiquettes correspondent".
     */
    confirmed_package_count: z.number().int().nonnegative().max(100).optional(),
  }),
);

/**
 * Completing a delivery, with what happened at the door.
 *
 * Either money changed hands, or it did not and the pharmacy said to hand the
 * order over anyway ("Si le client n'a pas la possibilité de payer, le livreur
 * doit appeler la pharmacie et demander quoi faire"). Both at once is a
 * contradiction, so it is refused rather than silently resolved.
 */
export const completeBodySchema = emptyBodyAsObject(
  z
    .object({
      payment: z
        .object({
          payment_method: z.enum(["cash", "card"]),
          amount_collected: amountSchema,
        })
        .optional(),
      payment_exception: paymentExceptionSchema.optional(),
      payment_exception_note: z.string().trim().max(500).optional(),
    })
    .superRefine((body, ctx) => {
      if (body.payment && body.payment_exception) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Provide either a payment or a payment_exception, not both — money was collected or it was not",
        });
      }
      if (body.payment_exception_note && !body.payment_exception) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "payment_exception_note requires a payment_exception",
        });
      }
    }),
);

/**
 * A failed delivery must say why (scénario B: "doit justifier en sélectionnant
 * que le client était absent. Il peut ajouter une note à sa discrétion").
 */
export const returnBodySchema = z.object({
  reason: failureReasonSchema,
  note: z.string().trim().max(500).optional(),
});

/** The driver hands the whole stack back at once, so this takes a batch. */
export const handoverBodySchema = z.object({
  order_ids: z.array(z.string().uuid()).min(1).max(100),
});

export const handoverResponseSchema = z.object({
  handed_over: z.array(closedStopSchema),
  count: z.number(),
});

export const priorityBodySchema = z.object({
  is_priority: z.boolean(),
});

export const paymentBodySchema = z.object({
  payment_method: z.enum(["cash", "card"]),
  amount_collected: amountSchema,
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

// --- notifications ---------------------------------------------------------

export const notificationsQuerySchema = z.object({
  unread: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const notificationsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().uuid(),
      type: z.enum([
        "order_assigned",
        "order_ready",
        "order_unassigned",
        "order_cancelled",
      ]),
      order_id: z.string().uuid().nullable(),
      delivery_date: z.string().nullable(),
      created_at: z.string(),
      read_at: z.string().nullable(),
    }),
  ),
  unread_count: z.number(),
});

export const markNotificationsReadBodySchema = emptyBodyAsObject(
  z.object({
    /** Omit to mark the whole feed read. */
    ids: z.array(z.string().uuid()).max(200).optional(),
  }),
);

export const markNotificationsReadResponseSchema = z.object({
  updated: z.number(),
});
