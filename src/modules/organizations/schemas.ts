import { z } from "zod";

/**
 * The pharmacy's own record, as the dashboard's Settings page needs it.
 *
 * WHY THE COORDINATE IS PART OF THE CONTRACT
 *
 * `latitude`/`longitude` are the depot a driver's route starts from and
 * returns to (`orders/routeService.ts`, `driver/service.ts`). Until migration
 * 014 they had no writer at all, so every route was solved as an open tour
 * from nowhere and every ETA degraded. Exposing them here — nullable, and
 * visibly so — is what lets an admin see that the depot is missing and fix it
 * without a DBA.
 */
export const organizationResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  address: z.string().nullable(),
  place_id: z.string().nullable(),
  formatted_address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  geocoded_at: z.date().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
});

/**
 * The address and the geocode behind it, sent as one unit.
 *
 * Same shape the order and patient forms send: the dashboard resolves a
 * chosen Places suggestion through `/v1/places/resolve/{place_id}` and posts
 * the result. A coordinate is never accepted on its own — see the refinement,
 * and the paired-coordinate CHECK constraint behind it.
 *
 * Deliberately narrow: name, phone, email, rate and windows are not editable
 * here. This endpoint exists to give the depot a writer, and widening it into
 * a general organization editor would put billing fields behind a form built
 * for an address.
 */
export const updateOrganizationBodySchema = z
  .object({
    address: z.string().trim().min(1).max(500).nullable().optional(),
    place_id: z.string().trim().min(1).max(255).nullable().optional(),
    formatted_address: z.string().trim().min(1).max(500).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  })
  .superRefine((body, ctx) => {
    const hasLat = body.latitude !== undefined && body.latitude !== null;
    const hasLng = body.longitude !== undefined && body.longitude !== null;
    if (hasLat === hasLng) return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasLat ? "longitude" : "latitude"],
      message: "Latitude and longitude must be provided together",
    });
  });

export type UpdateOrganizationBody = z.infer<typeof updateOrganizationBodySchema>;
