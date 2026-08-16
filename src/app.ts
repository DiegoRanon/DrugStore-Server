import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { env } from "./config/env.js";
import { redis } from "./db/redis.js";
import authRoutes from "./modules/auth/routes.js";
import internalRoutes from "./modules/internal/routes.js";
import inviteRoutes from "./modules/invites/routes.js";
import authPlugin from "./plugins/auth.js";
import errorHandlerPlugin from "./plugins/errorHandler.js";
import requestIdPlugin from "./plugins/requestId.js";

/**
 * Fields scrubbed from every log line. PRD §8.6 forbids PII in application
 * logs; doing it at the logger means a future `request.log.info({ order })`
 * cannot leak a patient address by accident.
 */
const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.body.password",
  "req.body.current_password",
  "req.body.new_password",
  "req.body.refresh_token",
  "req.body.access_token",
  "*.patient_name",
  "*.address",
  "*.phone_number",
  "*.phone",
  "*.email",
  "*.password_hash",
  "*.token_hash",
];

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
      ...(env.isProduction
        ? {}
        : { transport: { target: "pino-pretty", options: { colorize: true } } }),
    },
    // 1 MB is generous for the largest legitimate payload (a batch of
    // location pings) and bounds memory per request (PRD §8.6).
    bodyLimit: 1_048_576,
    disableRequestLogging: false,
    trustProxy: true,
  });

  // Zod drives both validation and response serialization.
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  await fastify.register(requestIdPlugin);
  await fastify.register(errorHandlerPlugin);

  await fastify.register(fastifyHelmet, {
    // This is a JSON API with no browser-rendered content; CSP would only
    // apply to error pages, and HSTS is terminated at the load balancer.
    contentSecurityPolicy: false,
  });

  await fastify.register(fastifyCors, {
    // Strict allow-list. An empty list means same-origin only, which is the
    // correct default for a server whose clients are a mobile app and one
    // known dashboard origin.
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
    credentials: true,
  });

  await fastify.register(fastifyRateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute",
    // Per authenticated user where possible, falling back to IP for public
    // routes. Without this, every driver behind one carrier NAT would share
    // a single budget.
    keyGenerator: (request) => request.ctx?.userId ?? request.ip,
    redis,
    nameSpace: "ratelimit:",
  });

  await fastify.register(authPlugin);

  fastify.get(
    "/health",
    { logLevel: "warn" },
    async () => ({ status: "ok", service: "drugstore-server" }),
  );

  await fastify.register(authRoutes, { prefix: "/v1/auth" });
  await fastify.register(inviteRoutes, { prefix: "/v1/invites" });
  await fastify.register(internalRoutes, { prefix: "/v1/internal" });

  return fastify;
}
