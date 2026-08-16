import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { AppError } from "../../core/errors.js";
import { db } from "../../db/knex.js";
import { hashPassword } from "../auth/password.js";
import { emailSchema, passwordSchema } from "../auth/schemas.js";

/**
 * Platform provisioning API.
 *
 * The PRD describes drivers joining an organization by invite code, but never
 * says how an organization or its first admin comes into existence — and the
 * DB enforces exactly one admin per organization. These routes fill that gap.
 *
 * Guarded by a static service token rather than a user JWT: they create the
 * very accounts that user tokens are issued from, so no user session should
 * ever be able to reach them.
 */
const internalRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", fastify.requireInternalToken);

  fastify.post(
    "/organizations",
    {
      schema: {
        tags: ["internal"],
        summary: "Create an organization and its admin account",
        body: z.object({
          name: z.string().trim().min(1).max(255),
          address: z.string().trim().max(500).optional(),
          phone: z.string().trim().max(50).optional(),
          email: emailSchema.optional(),
          timezone: z.string().max(64).default("America/Toronto"),
          locale: z.enum(["fr", "en"]).default("fr"),
          delivery_rate: z.number().nonnegative().default(0),
          admin: z.object({
            email: emailSchema,
            password: passwordSchema,
            first_name: z.string().trim().min(1).max(100),
            last_name: z.string().trim().min(1).max(100),
            phone: z.string().trim().max(50).optional(),
          }),
        }),
        response: {
          201: z.object({
            organization: z.object({
              id: z.string().uuid(),
              name: z.string(),
              delivery_rate: z.number(),
            }),
            admin: z.object({
              id: z.string().uuid(),
              email: z.string(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const passwordHash = await hashPassword(body.admin.password);

      // One transaction: an organization with no admin is unusable, and an
      // admin with no organization violates chk_admin_has_organization.
      const result = await db.transaction(async (trx) => {
        const [org] = await trx("organizations")
          .insert({
            name: body.name,
            address: body.address ?? null,
            phone: body.phone ?? null,
            email: body.email ?? null,
            timezone: body.timezone,
            locale: body.locale,
            delivery_rate: body.delivery_rate,
          })
          .returning(["id", "name", "delivery_rate"]);

        const [admin] = await trx("users")
          .insert({
            organization_id: org.id,
            role: "admin",
            email: body.admin.email,
            password_hash: passwordHash,
            first_name: body.admin.first_name,
            last_name: body.admin.last_name,
            phone: body.admin.phone ?? null,
          })
          .returning(["id", "email"]);

        return { organization: org, admin };
      });

      return reply.status(201).send(result);
    },
  );

  fastify.patch(
    "/organizations/:id",
    {
      schema: {
        tags: ["internal"],
        summary: "Update billing rate and delivery window settings",
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            delivery_rate: z.number().nonnegative().optional(),
            timezone: z.string().max(64).optional(),
            locale: z.enum(["fr", "en"]).optional(),
            am_window_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            am_window_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            pm_window_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            pm_window_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            is_active: z.boolean().optional(),
          })
          .refine((body) => Object.keys(body).length > 0, {
            message: "At least one field must be provided",
          }),
        response: {
          200: z.object({
            id: z.string().uuid(),
            name: z.string(),
            delivery_rate: z.number(),
            timezone: z.string(),
            locale: z.string(),
            am_window_start: z.string(),
            am_window_end: z.string(),
            pm_window_start: z.string(),
            pm_window_end: z.string(),
            is_active: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      const [updated] = await db("organizations")
        .where({ id: request.params.id })
        .update(request.body)
        .returning([
          "id",
          "name",
          "delivery_rate",
          "timezone",
          "locale",
          "am_window_start",
          "am_window_end",
          "pm_window_start",
          "pm_window_end",
          "is_active",
        ]);

      if (!updated) throw new AppError("NOT_FOUND", "Organization not found");
      return updated;
    },
  );

  fastify.get(
    "/organizations",
    {
      schema: {
        tags: ["internal"],
        summary: "List organizations",
        response: {
          200: z.object({
            data: z.array(
              z.object({
                id: z.string().uuid(),
                name: z.string(),
                delivery_rate: z.number(),
                is_active: z.boolean(),
                created_at: z.date(),
              }),
            ),
          }),
        },
      },
    },
    async () => {
      const data = await db("organizations")
        .select("id", "name", "delivery_rate", "is_active", "created_at")
        .orderBy("created_at", "desc")
        .limit(200);
      return { data };
    },
  );
};

export default internalRoutes;
