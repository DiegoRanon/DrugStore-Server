import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import {
  organizationResponseSchema,
  updateOrganizationBodySchema,
} from "./schemas.js";
import { OrganizationsService } from "./service.js";

/**
 * The pharmacy's own record. Admin only — a driver has no business reading
 * the organization's contact details, and no business moving the depot.
 */
const organizationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("preHandler", fastify.requireRole("admin"));

  fastify.get(
    "/",
    {
      schema: {
        tags: ["organization"],
        summary: "The signed-in admin's pharmacy",
        description:
          "Includes the depot coordinate. A null latitude means routes are not anchored at the pharmacy and driver ETAs degrade.",
        response: { 200: organizationResponseSchema },
      },
    },
    async (request) => {
      const service = new OrganizationsService(request.ctx, request.log);
      return service.get();
    },
  );

  fastify.patch(
    "/",
    {
      schema: {
        tags: ["organization"],
        summary: "Set the pharmacy address and depot coordinate",
        description:
          "The geocode is written as one unit with the address: sending an address with no coordinates clears the depot rather than leaving a stale one behind.",
        body: updateOrganizationBodySchema,
        response: { 200: organizationResponseSchema },
      },
    },
    async (request) => {
      const service = new OrganizationsService(request.ctx, request.log);
      return service.update(request.body);
    },
  );
};

export default organizationRoutes;
