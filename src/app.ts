import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { env } from "./config/env.js";
import { redis } from "./db/redis.js";
import authRoutes from "./modules/auth/routes.js";
import clientRoutes from "./modules/clients/routes.js";
import driverRoutes from "./modules/driver/routes.js";
import driverRosterRoutes from "./modules/drivers/routes.js";
import internalRoutes from "./modules/internal/routes.js";
import inviteRoutes from "./modules/invites/routes.js";
import orderRoutes from "./modules/orders/routes.js";
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
  // Who may accept the package, and the driver's free-text explanation of a
  // failed delivery — both routinely name a person.
  "*.authorized_recipient",
  "*.failure_note",
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

  // Generated from the Zod schemas the routes already declare, so the spec
  // cannot drift from what the server actually validates. Registered before
  // the routes because the generator collects them as they are added.
  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Drugstore Delivery API",
        description:
          "B2B pharmacy delivery logistics. Carries no medical, pharmaceutical, or prescription data.",
        version: "1.0.0",
      },
      servers: [{ url: env.PUBLIC_BASE_URL }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Access token from POST /v1/auth/login.",
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  // The spec describes an API over personal information; browsable docs are a
  // development convenience, not something to expose in production.
  if (!env.isProduction) {
    await fastify.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  fastify.get(
    "/health",
    { logLevel: "warn", schema: { hide: true } },
    async () => ({ status: "ok", service: "drugstore-server" }),
  );

  await fastify.register(authRoutes, { prefix: "/v1/auth" });
  await fastify.register(inviteRoutes, { prefix: "/v1/invites" });
  await fastify.register(clientRoutes, { prefix: "/v1/clients" });
  await fastify.register(orderRoutes, { prefix: "/v1/orders" });
  await fastify.register(driverRosterRoutes, { prefix: "/v1/drivers" });
  await fastify.register(driverRoutes, { prefix: "/v1/driver" });
  await fastify.register(internalRoutes, { prefix: "/v1/internal" });

  return fastify;
}
