import { z } from "zod";

/**
 * Zod schemas double as Fastify's request validation and as the source of the
 * TypeScript types, so validation at the edge (PRD §3) cannot drift from what
 * the handlers actually expect.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Must be a valid email address")
  .max(255);

/**
 * Length over composition rules: NIST SP 800-63B recommends a long minimum
 * and no mandatory character classes, which produces stronger passwords in
 * practice than "one uppercase, one symbol".
 */
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(200, "Password must be at most 200 characters");

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required").max(200),
});

export const refreshBodySchema = z.object({
  refresh_token: z.string().min(1),
});

export const logoutBodySchema = z.object({
  refresh_token: z.string().min(1),
});

export const registerDriverBodySchema = z.object({
  code: z.string().trim().min(1).max(32),
  email: emailSchema,
  password: passwordSchema,
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(50).optional(),
});

export const changePasswordBodySchema = z
  .object({
    current_password: z.string().min(1).max(200),
    new_password: passwordSchema,
  })
  .refine((body) => body.current_password !== body.new_password, {
    path: ["new_password"],
    message: "The new password must be different from the current one",
  });

// --- responses -------------------------------------------------------------

export const sessionResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string(),
    role: z.enum(["admin", "driver"]),
    first_name: z.string(),
    last_name: z.string(),
    organization_id: z.string().uuid(),
  }),
});

export const meResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string(),
    role: z.enum(["admin", "driver"]),
    first_name: z.string(),
    last_name: z.string(),
    phone: z.string().nullable(),
  }),
  organization: z.object({
    id: z.string().uuid(),
    name: z.string(),
    phone: z.string().nullable(),
    timezone: z.string(),
    locale: z.string(),
  }),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type RegisterDriverBody = z.infer<typeof registerDriverBodySchema>;
