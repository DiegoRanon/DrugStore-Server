import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { InvitesService } from "./service.js";

const inviteCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  is_active: z.boolean(),
  expires_at: z.string().nullable(),
  redeemed_at: z.string().nullable(),
  created_at: z.string(),
});

/** Admin-only invite code management backing PRD §4.3 step 1. */
const inviteRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("preHandler", fastify.requireRole("admin"));

  fastify.post(
    "/",
    {
      schema: {
        tags: ["invites"],
        summary: "Generate a driver invite code",
        body: z.object({ expires_at: z.coerce.date().optional() }),
        response: { 201: inviteCodeSchema },
      },
    },
    async (request, reply) => {
      const service = new InvitesService(request.ctx);
      const code = await service.create(request.body.expires_at);
      return reply.status(201).send(code);
    },
  );

  fastify.get(
    "/",
    {
      schema: {
        tags: ["invites"],
        summary: "List invite codes for this organization",
        querystring: z.object({
          is_active: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ data: z.array(inviteCodeSchema) }) },
      },
    },
    async (request) => {
      const service = new InvitesService(request.ctx);
      const data = await service.list({
        isActive: request.query.is_active,
        limit: request.query.limit,
      });
      return { data };
    },
  );

  fastify.delete(
    "/:id",
    {
      schema: {
        tags: ["invites"],
        summary: "Deactivate an unredeemed invite code",
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const service = new InvitesService(request.ctx);
      await service.deactivate(request.params.id);
      return reply.status(204).send(null);
    },
  );
};

export default inviteRoutes;
