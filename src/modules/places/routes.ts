import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import {
  autocompleteQuerySchema,
  autocompleteResponseSchema,
  resolveParamsSchema,
  resolveQuerySchema,
  resolveResponseSchema,
} from "./schemas.js";
import { PlacesService } from "./service.js";

/**
 * Address standardization, brokered for the dashboard (Route Optimizer).
 *
 * Admin-only. Drivers have no use for it — they receive addresses that were
 * already standardized when the order was taken — and every extra role with
 * access is another way for a key that bills per call to be spent.
 *
 * RATE LIMIT
 *
 * Tighter than the global 100/minute. Autocomplete fires on a debounced
 * keystroke, so a single employee filling one form legitimately produces a
 * burst; the ceiling here is set to absorb that while still capping what a
 * compromised admin session could run up on the account.
 */
const placesRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("preHandler", fastify.requireRole("admin"));

  fastify.get(
    "/autocomplete",
    {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
      schema: {
        tags: ["places"],
        summary: "Address suggestions for a partial input",
        description:
          "Proxies the configured Places provider. Returns an empty list when the provider is unavailable, so an address can always still be typed by hand. Pass the same session_token for every keystroke of one address and for the resolve call that follows.",
        querystring: autocompleteQuerySchema,
        response: { 200: autocompleteResponseSchema },
      },
    },
    async (request) => {
      const service = new PlacesService(request.ctx, request.log);
      return {
        data: await service.suggest(
          request.query.q,
          request.query.session_token,
        ),
      };
    },
  );

  fastify.get(
    "/:place_id",
    {
      config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
      schema: {
        tags: ["places"],
        summary: "Resolve a chosen suggestion to an address and coordinates",
        description:
          "Closes the autocomplete session. Unlike the suggestion endpoint this fails loudly, because it runs after a deliberate choice.",
        params: resolveParamsSchema,
        querystring: resolveQuerySchema,
        response: { 200: resolveResponseSchema },
      },
    },
    async (request) => {
      const service = new PlacesService(request.ctx, request.log);
      return service.resolve(
        request.params.place_id,
        request.query.session_token,
      );
    },
  );
};

export default placesRoutes;
