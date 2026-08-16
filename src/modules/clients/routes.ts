import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  clientListResponseSchema,
  clientResponseSchema,
  createClientBodySchema,
  listClientsQuerySchema,
  updateClientBodySchema,
} from "./schemas.js";
import { ClientsService } from "./service.js";

/** PRD §5.1 — the saved patient list. Admin only. */
const clientRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("preHandler", fastify.requireRole("admin"));

  fastify.get(
    "/",
    {
      schema: {
        tags: ["clients"],
        summary: "List saved clients",
        querystring: listClientsQuerySchema,
        response: { 200: clientListResponseSchema },
      },
    },
    async (request) => {
      const service = new ClientsService(request.ctx, request.log);
      return service.list({
        search: request.query.search,
        isActive: request.query.is_active,
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
    },
  );

  fastify.post(
    "/",
    {
      schema: {
        tags: ["clients"],
        summary: "Create a client",
        body: createClientBodySchema,
        response: { 201: clientResponseSchema },
      },
    },
    async (request, reply) => {
      const service = new ClientsService(request.ctx, request.log);
      const client = await service.create(request.body);
      return reply.status(201).send(client);
    },
  );

  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["clients"],
        summary: "Get a client",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: clientResponseSchema },
      },
    },
    async (request) => {
      const service = new ClientsService(request.ctx, request.log);
      return service.get(request.params.id);
    },
  );

  fastify.patch(
    "/:id",
    {
      schema: {
        tags: ["clients"],
        summary: "Update a client",
        params: z.object({ id: z.string().uuid() }),
        body: updateClientBodySchema,
        response: { 200: clientResponseSchema },
      },
    },
    async (request) => {
      const service = new ClientsService(request.ctx, request.log);
      return service.update(request.params.id, request.body);
    },
  );

  fastify.delete(
    "/:id",
    {
      schema: {
        tags: ["clients"],
        summary: "Deactivate a client (soft delete)",
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const service = new ClientsService(request.ctx, request.log);
      await service.deactivate(request.params.id);
      return reply.status(204).send(null);
    },
  );
};

export default clientRoutes;
