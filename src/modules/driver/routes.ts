import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import idempotencyPlugin from "../../plugins/idempotency.js";
import {
  coolerCheckBodySchema,
  driverOrderSchema,
  optimizeBodySchema,
  paymentBodySchema,
  paymentResponseSchema,
  queueQuerySchema,
  queueResponseSchema,
} from "./schemas.js";
import { DriverService } from "./service.js";

/** Server-local calendar date, used when the app does not name one. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Driver-facing endpoints (PRD §5.4).
 *
 * Every route here returns the driver view of an order, never the admin view,
 * so patient details disappear the moment a delivery closes (§8.3). Mutations
 * honour `Idempotency-Key` because the app retries on flaky mobile networks.
 */
const driverRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("preHandler", fastify.requireRole("driver"));

  // Registered after authentication so keys are namespaced per driver.
  await fastify.register(idempotencyPlugin);

  fastify.get(
    "/queue",
    {
      schema: {
        tags: ["driver"],
        summary: "Active stops for a day, in route order",
        querystring: queueQuerySchema,
        response: { 200: queueResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.getQueue(request.query.date ?? today());
    },
  );

  fastify.post(
    "/queue/optimize",
    {
      schema: {
        tags: ["driver"],
        summary: "Recalculate the optimal stop order",
        body: optimizeBodySchema,
        response: { 200: queueResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.optimizeQueue(
        request.body.date ?? today(),
        request.body.current_location,
      );
    },
  );

  fastify.post(
    "/orders/:id/pickup",
    {
      schema: {
        tags: ["driver"],
        summary: "Take custody of the package",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.pickup(request.params.id);
    },
  );

  fastify.post(
    "/orders/:id/complete",
    {
      schema: {
        tags: ["driver"],
        summary: "One-tap proof of delivery",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.complete(request.params.id);
    },
  );

  fastify.post(
    "/orders/:id/return",
    {
      schema: {
        tags: ["driver"],
        summary: "Patient unavailable — return the package",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.return(request.params.id);
    },
  );

  fastify.post(
    "/orders/:id/payment",
    {
      schema: {
        tags: ["driver"],
        summary: "Record a collection taken on the physical POS",
        params: z.object({ id: z.string().uuid() }),
        body: paymentBodySchema,
        response: { 200: paymentResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.recordPayment(request.params.id, request.body);
    },
  );

  fastify.post(
    "/orders/:id/cooler-check",
    {
      schema: {
        tags: ["driver"],
        summary: "Post-delivery cooler bag quality check",
        params: z.object({ id: z.string().uuid() }),
        body: coolerCheckBodySchema,
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.recordCoolerCheck(
        request.params.id,
        request.body.confirmed,
      );
    },
  );
};

export default driverRoutes;
