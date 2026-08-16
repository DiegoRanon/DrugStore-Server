import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

/**
 * Every response carries X-Request-Id for support and log correlation
 * (PRD §3). An inbound value is trusted only for correlation across our own
 * services — it is never used for authorization, and it is length-capped so a
 * client cannot bloat our logs.
 */
const requestIdPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", async (request, reply) => {
    const inbound = request.headers["x-request-id"];
    const requestId =
      typeof inbound === "string" && inbound.length > 0 && inbound.length <= 64
        ? inbound
        : randomUUID();

    request.requestId = requestId;
    reply.header("x-request-id", requestId);
  });
};

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

export default fp(requestIdPlugin, { name: "request-id" });
