import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  driverDeactivationResponseSchema,
  driverListResponseSchema,
  driverResponseSchema,
  listDriversQuerySchema,
  updateDriverBodySchema,
} from "./schemas.js";
import { DriversService } from "./service.js";

/**
 * Driver roster (MVP §6 "User Management"). Admin only.
 *
 * Drivers join through the invite-code flow in /v1/auth, so there is no create
 * endpoint here — this manages who is already in the organization.
 */
const driverRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("preHandler", fastify.requireRole("admin"));

  fastify.get(
    "/",
    {
      schema: {
        tags: ["drivers"],
        summary: "List drivers in this organization",
        querystring: listDriversQuerySchema,
        response: { 200: driverListResponseSchema },
      },
    },
    async (request) => {
      const service = new DriversService(request.ctx, request.log);
      return service.list({
        search: request.query.search,
        isActive: request.query.is_active,
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
    },
  );

  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["drivers"],
        summary: "Get a driver",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: driverResponseSchema },
      },
    },
    async (request) => {
      const service = new DriversService(request.ctx, request.log);
      return service.get(request.params.id);
    },
  );

  fastify.patch(
    "/:id",
    {
      schema: {
        tags: ["drivers"],
        summary: "Activate or deactivate a driver",
        description:
          "Deactivating revokes the driver's refresh tokens immediately. Any orders still assigned to them are reported in active_order_count so they can be reassigned.",
        params: z.object({ id: z.string().uuid() }),
        body: updateDriverBodySchema,
        response: { 200: driverDeactivationResponseSchema },
      },
    },
    async (request) => {
      const service = new DriversService(request.ctx, request.log);
      return service.setActive(request.params.id, request.body.is_active);
    },
  );
};

export default driverRoutes;
