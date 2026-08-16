import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

import { AppError, mapDatabaseError } from "../core/errors.js";

/**
 * Single exit point for every failure, so the PRD §3 envelope is guaranteed
 * rather than repeated per route.
 *
 * Three classes of error arrive here:
 *   1. AppError        — deliberate, already carries a code and status.
 *   2. Zod validation  — flattened into field-level details.
 *   3. Everything else — logged in full, reported as a bare 500. Internal
 *      messages never reach the client, since they can leak schema or PII.
 */
const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
        details: {},
      },
    });
  });

  fastify.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const fields = error.validation.map((issue) => ({
        path: issue.instancePath,
        message: issue.message,
      }));

      request.log.info({ fields }, "request validation failed");
      return reply.status(400).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "The request did not pass validation",
          details: { fields },
        },
      });
    }

    if (error instanceof AppError) {
      // Client mistakes are not warnings; only 5xx deserves error level.
      const level = error.statusCode >= 500 ? "error" : "info";
      request.log[level](
        { code: error.code, statusCode: error.statusCode },
        error.message,
      );
      return reply.status(error.statusCode).send(error.toEnvelope());
    }

    const mapped = mapDatabaseError(error);
    if (mapped) {
      request.log.info(
        { code: mapped.code },
        "database constraint mapped to business error",
      );
      return reply.status(mapped.statusCode).send(mapped.toEnvelope());
    }

    // Fastify's own errors (body too large, unsupported media type, and the
    // rate limiter) already carry a sensible status.
    const fastifyError = error as { statusCode?: number; message?: string };
    const statusCode = fastifyError.statusCode ?? 500;
    if (statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Please slow down.",
          details: {},
        },
      });
    }
    if (statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: "VALIDATION_FAILED",
          message: fastifyError.message ?? "Request could not be processed",
          details: {},
        },
      });
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        details: { request_id: request.requestId },
      },
    });
  });
};

export default fp(errorHandlerPlugin, {
  name: "error-handler",
  dependencies: ["request-id"],
});
