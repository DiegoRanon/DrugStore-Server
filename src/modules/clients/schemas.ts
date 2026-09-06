import { z } from "zod";

/**
 * `notes` is capped at 500 characters to match the column, but the real
 * control is intent: PRD §5.1 wants logistics ("buzz code 4412", "leave with
 * concierge") and explicitly not a shadow medical record. Nothing is stripped
 * automatically — the server logs a compliance warning and returns a reminder
 * for the UI to surface.
 */
export const notesSchema = z
  .string()
  .trim()
  .max(500, "Notes are limited to 500 characters")
  .nullable()
  .optional();

/**
 * The geocode captured when staff picked the address from Places. Optional
 * throughout: a hand-typed address is still a valid patient record, it just
 * cannot take part in route optimization.
 */
const clientGeocodeFields = {
  place_id: z.string().trim().min(1).max(255).nullable().optional(),
  formatted_address: z.string().trim().min(1).max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
};

export const createClientBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  address: z.string().trim().min(1).max(500),
  phone_number: z.string().trim().min(1).max(50),
  ...clientGeocodeFields,
  notes: notesSchema,
});

export const updateClientBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    phone_number: z.string().trim().min(1).max(50).optional(),
    ...clientGeocodeFields,
    notes: notesSchema,
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });

export const listClientsQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  is_active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const clientResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  address: z.string(),
  phone_number: z.string(),
  place_id: z.string().nullable(),
  formatted_address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  /**
   * Present only when `notes` holds content, so the dashboard can show the
   * "logistics only — no medical information" reminder next to the field.
   */
  compliance_reminder: z.string().optional(),
});

export const clientListResponseSchema = z.object({
  data: z.array(clientResponseSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
