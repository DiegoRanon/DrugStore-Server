import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  assignDriverBodySchema,
  calendarQuerySchema,
  calendarResponseSchema,
  createOrderBodySchema,
  listOrdersQuerySchema,
  orderDetailResponseSchema,
  orderListResponseSchema,
  orderResponseSchema,
  setPriorityBodySchema,
  updateOrderBodySchema,
} from "./schemas.js";
import { OrdersService } from "./service.js";

/**
 * Admin-facing order endpoints (PRD §5.2). The driver-facing surface — queue,
 * pickup, complete, return, handover — lives in ../driver and drives the same
 * state machine through the same service.
 */
const orderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("preHandler", fastify.requireRole("admin"));

  fastify.post(
    "/",
    {
      schema: {
        tags: ["orders"],
        summary: "Schedule a delivery, snapshotting client details",
        description:
          "Creates the order in the admin calendar with status 'scheduled'. It is invisible to drivers until staff call POST /v1/orders/{id}/ready.",
        body: createOrderBodySchema,
        response: { 201: orderResponseSchema },
      },
    },
    async (request, reply) => {
      const service = new OrdersService(request.ctx, request.log);
      const order = await service.create(request.body);
      return reply.status(201).send(order);
    },
  );

  fastify.get(
    "/",
    {
      schema: {
        tags: ["orders"],
        summary: "Logistical history view",
        querystring: listOrdersQuerySchema,
        response: { 200: orderListResponseSchema },
      },
    },
    async (request) => {
      const service = new OrdersService(request.ctx, request.log);
      return service.list({
        date: request.query.date,
        from: request.query.from,
        to: request.query.to,
        status: request.query.status,
        driverId: request.query.driver_id,
        clientId: request.query.client_id,
        isPriority: request.query.is_priority,
        updatedSince: request.query.updated_since,
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
    },
  );

  // Registered before /:id so the intent is obvious to a reader; Fastify would
  // prefer the static segment regardless.
  fastify.get(
    "/calendar",
    {
      schema: {
        tags: ["orders"],
        summary: "Per-day order counts for the admin calendar",
        description:
          "Counts only — no patient details are returned, and this read is not audit-logged.",
        querystring: calendarQuerySchema,
        response: { 200: calendarResponseSchema },
      },
    },
    async (request) => {
      const service = new OrdersService(request.ctx, request.log);
      return service.calendar({
        from: request.query.from,
        to: request.query.to,
      });
    },
  );

  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["orders"],
        summary: "Order detail with its status timeline",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: orderDetailResponseSchema },
      },
    },
    async (request) => {
      const service = new OrdersService(request.ctx, request.log);
      return service.get(request.params.id);
    },
  );

  fastify.patch(
    "/:id",
    {
      schema: {
        tags: ["orders"],
        summary: "Edit an order (only while scheduled or in_pharmacy)",
        params: z.object({ id: z.string().uuid() }),
        body: updateOrderBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const service = new OrdersService(request.ctx, request.log);
      return service.update(request.params.id, request.body);
    },
  );

  fastify.post(
    "/:id/ready",
    {
      schema: {
        tags: ["orders"],
        summary: "Declare the order physically prepared and ready for pickup",
        description:
          "Moves the order out of the calendar and onto the counter. Notifies the assigned driver, if there is one.",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const service = new OrdersService(request.ctx, request.log);
      return service.markReady(request.params.id);
    },
  );

  fastify.post(
    "/:id/assign",
    {
      schema: {
        tags: ["orders"],
        summary: "Assign or reassign a driver",
        params: z.object({ id: z.string().uuid() }),
        body: assignDriverBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const service = new OrdersService(request.ctx, request.log);
      return service.assignDriver(request.params.id, request.body.driver_id);
    },
  );

  fastify.post(
    "/:id/priority",
    {
      schema: {
        tags: ["orders"],
        summary: "Flag or unflag an order as a priority stop",
        params: z.object({ id: z.string().uuid() }),
        body: setPriorityBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const service = new OrdersService(request.ctx, request.log);
      return service.setPriority(request.params.id, request.body.is_priority);
    },
  );

  fastify.post(
    "/:id/cancel",
    {
      schema: {
        tags: ["orders"],
        summary: "Cancel an order that never left the pharmacy",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const service = new OrdersService(request.ctx, request.log);
      return service.cancel(request.params.id);
    },
  );
};

export default orderRoutes;
