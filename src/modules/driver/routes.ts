import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import idempotencyPlugin from "../../plugins/idempotency.js";
import {
  completeBodySchema,
  coolerCheckBodySchema,
  driverOrderSchema,
  etaBodySchema,
  etaResponseSchema,
  handoverBodySchema,
  handoverResponseSchema,
  markNotificationsReadBodySchema,
  markNotificationsReadResponseSchema,
  notificationsQuerySchema,
  notificationsResponseSchema,
  optimizeBodySchema,
  paymentBodySchema,
  paymentResponseSchema,
  pickupBodySchema,
  priorityBodySchema,
  queueQuerySchema,
  queueResponseSchema,
  returnBodySchema,
  sequenceBodySchema,
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
 * so patient details disappear the moment a delivery attempt closes — which
 * now includes a failed one still awaiting handover. Mutations honour
 * Idempotency-Key because the app retries on flaky mobile networks.
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
        summary: "The driver's day: stops, packages owed back, and totals",
        querystring: queueQuerySchema,
        response: { 200: queueResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.getQueue(request.query.date ?? today(), {
        updatedSince: request.query.updated_since,
      });
    },
  );

  fastify.post(
    "/queue/optimize",
    {
      schema: {
        tags: ["driver"],
        summary: "Suggest a stop order and travel estimates",
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

  /**
   * How long the rest of the run takes, in current traffic.
   *
   * A read that costs money: it calls the Routes API, so the app asks for it
   * when the answer would have changed — on arrival at the screen, and after
   * each delivery or return — never on the queue poll.
   *
   * Writes nothing. The stop order is an input here, not an output; a driver
   * checking their ETA must not risk being handed a different route.
   */
  fastify.post(
    "/queue/eta",
    {
      schema: {
        tags: ["driver"],
        summary: "Traffic-aware arrival times for the remaining stops",
        description:
          "Measures the chain the queue is already in: pharmacy to the first stop, then stop to stop. Includes a fixed allowance for time at each door, so finish_time is when the driver is done rather than when they last arrive. Returns degraded: true and no stops when the provider is unavailable — never an invented number.",
        body: etaBodySchema,
        response: { 200: etaResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.routeEta(
        request.body.date ?? today(),
        request.body.current_location,
      );
    },
  );

  fastify.post(
    "/queue/sequence",
    {
      schema: {
        tags: ["driver"],
        summary: "Set the stop order manually",
        description:
          "The driver chooses their own route; this records it. Overrides whatever the optimizer suggested.",
        body: sequenceBodySchema,
        response: { 200: queueResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.setSequence(
        request.body.date ?? today(),
        request.body.ordered_order_ids,
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
        body: pickupBodySchema,
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.pickup(request.params.id, request.body);
    },
  );

  fastify.post(
    "/orders/:id/complete",
    {
      schema: {
        tags: ["driver"],
        summary: "Proof of delivery, with the payment taken at the door",
        params: z.object({ id: z.string().uuid() }),
        body: completeBodySchema,
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.complete(request.params.id, request.body);
    },
  );

  fastify.post(
    "/orders/:id/return",
    {
      schema: {
        tags: ["driver"],
        summary: "Mark a delivery failed, with the reason",
        description:
          "The package stays with the driver until it is handed back at the pharmacy via POST /v1/driver/returns/handover.",
        params: z.object({ id: z.string().uuid() }),
        body: returnBodySchema,
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.return(request.params.id, request.body);
    },
  );

  fastify.post(
    "/orders/:id/handover",
    {
      schema: {
        tags: ["driver"],
        summary: "Confirm the pharmacy took one undelivered package back",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      const [handed] = await service.handover([request.params.id]);
      return handed!;
    },
  );

  fastify.post(
    "/returns/handover",
    {
      schema: {
        tags: ["driver"],
        summary: "Confirm the pharmacy took the undelivered packages back",
        body: handoverBodySchema,
        response: { 200: handoverResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      const handedOver = await service.handover(request.body.order_ids);
      return { handed_over: handedOver, count: handedOver.length };
    },
  );

  fastify.post(
    "/orders/:id/priority",
    {
      schema: {
        tags: ["driver"],
        summary: "Flag a stop the pharmacy called urgent at pickup",
        params: z.object({ id: z.string().uuid() }),
        body: priorityBodySchema,
        response: { 200: driverOrderSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.setPriority(request.params.id, request.body.is_priority);
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

  fastify.get(
    "/notifications",
    {
      schema: {
        tags: ["driver"],
        summary: "Orders assigned, readied, pulled, or cancelled for this driver",
        querystring: notificationsQuerySchema,
        response: { 200: notificationsResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.listNotifications({
        unreadOnly: request.query.unread ?? false,
        limit: request.query.limit,
      });
    },
  );

  fastify.post(
    "/notifications/read",
    {
      schema: {
        tags: ["driver"],
        summary: "Mark notifications read",
        body: markNotificationsReadBodySchema,
        response: { 200: markNotificationsReadResponseSchema },
      },
    },
    async (request) => {
      const service = new DriverService(request.ctx, request.log);
      return service.markNotificationsRead(request.body?.ids);
    },
  );
};

export default driverRoutes;
