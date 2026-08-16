import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  changePasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  meResponseSchema,
  refreshBodySchema,
  registerDriverBodySchema,
  sessionResponseSchema,
} from "./schemas.js";
import { AuthService } from "./service.js";

/** PRD §4.5 endpoints. */
const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const service = new AuthService(fastify);

  fastify.post(
    "/login",
    {
      schema: {
        tags: ["auth"],
        summary: "Unified admin/driver login",
        body: loginBodySchema,
        response: { 200: sessionResponseSchema },
      },
      // Tighter than the global limit: login is the endpoint worth brute
      // forcing. Per-email throttling lives in the service; this bounds a
      // single source spraying many addresses.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { email, password } = request.body;
      return service.login(email, password, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
    },
  );

  fastify.post(
    "/refresh",
    {
      schema: {
        tags: ["auth"],
        summary: "Rotate refresh token",
        body: refreshBodySchema,
        response: { 200: sessionResponseSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) =>
      service.refresh(request.body.refresh_token, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      }),
  );

  fastify.post(
    "/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Revoke refresh token",
        body: logoutBodySchema,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.logout(request.body.refresh_token);
      return reply.status(204).send(null);
    },
  );

  fastify.post(
    "/register/driver",
    {
      schema: {
        tags: ["auth"],
        summary: "Register a driver with an invite code",
        body: registerDriverBodySchema,
        response: {
          201: z.object({
            id: z.string().uuid(),
            email: z.string(),
            organization_id: z.string().uuid(),
          }),
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const result = await service.registerDriver(request.body);
      return reply.status(201).send(result);
    },
  );

  fastify.get(
    "/me",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["auth"],
        summary: "Current user and organization context",
        response: { 200: meResponseSchema },
      },
    },
    async (request) => service.me(request.ctx),
  );

  fastify.post(
    "/password/change",
    {
      onRequest: [fastify.authenticate],
      schema: {
        tags: ["auth"],
        summary: "Change own password",
        body: changePasswordBodySchema,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.changePassword(
        request.ctx,
        request.body.current_password,
        request.body.new_password,
      );
      return reply.status(204).send(null);
    },
  );
};

export default authRoutes;
