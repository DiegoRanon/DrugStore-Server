import { z } from "zod";

export const listDriversQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  is_active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/**
 * Employment status only. Names, email, and password belong to the driver and
 * are changed through /v1/auth — an admin managing a roster is not an admin
 * editing someone's credentials.
 */
export const updateDriverBodySchema = z.object({
  is_active: z.boolean(),
});

export const driverResponseSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const driverListResponseSchema = z.object({
  data: z.array(driverResponseSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

/**
 * Returned when a driver is deactivated with deliveries still open, so the
 * dashboard can prompt the admin to reassign them. Not an error: an admin
 * revoking access for a driver who walked off shift must not be blocked by
 * the very orders they need to move to someone else.
 */
export const driverDeactivationResponseSchema = driverResponseSchema.extend({
  active_order_count: z.number(),
});
