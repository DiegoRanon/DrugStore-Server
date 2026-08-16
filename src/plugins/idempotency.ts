import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

import { AppError } from "../core/errors.js";
import { idempotencyExpiry, requestFingerprint } from "../core/idempotency.js";
import { db } from "../db/knex.js";

interface IdempotencyRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  response_status: number | null;
  response_body: unknown;
  completed_at: Date | null;
  expires_at: Date;
}

interface IdempotencyState {
  rowId: string;
  key: string;
}

/**
 * Replays a previous response when a driver retries a mutation with the same
 * `Idempotency-Key` (PRD §3).
 *
 * Register inside an authenticated scope — the key is namespaced per user, so
 * `request.ctx` must already exist.
 *
 * Lifecycle:
 *   preHandler  reserve the key, or short-circuit with the stored response
 *   onSend      persist the outcome, or release the reservation on a 5xx so a
 *               genuine retry is still possible
 */
const idempotencyPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", async (request, reply) => {
    const header = request.headers["idempotency-key"];
    // Optional by design: PRD §3 says mutating driver endpoints *accept* the
    // header, not that they require it.
    if (typeof header !== "string" || header.length === 0) return;
    if (request.method === "GET") return;

    if (header.length > 255) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Idempotency-Key must be 255 characters or fewer",
      );
    }

    const fingerprint = requestFingerprint({
      method: request.method,
      url: request.url,
      body: request.body,
    });

    const reserve = async (): Promise<IdempotencyRow | undefined> => {
      const [row] = await db("idempotency_keys")
        .insert({
          user_id: request.ctx.userId,
          idempotency_key: header,
          request_fingerprint: fingerprint,
          expires_at: idempotencyExpiry(),
        })
        .onConflict(["user_id", "idempotency_key"])
        .ignore()
        .returning<IdempotencyRow[]>("*");
      return row;
    };

    let reserved = await reserve();

    if (!reserved) {
      const existing = await db<IdempotencyRow>("idempotency_keys")
        .where({ user_id: request.ctx.userId, idempotency_key: header })
        .first();

      if (existing && existing.expires_at.getTime() <= Date.now()) {
        // The key aged out; let the client reuse it rather than making them
        // invent a new one for what is, to them, the same action.
        await db("idempotency_keys").where({ id: existing.id }).del();
        reserved = await reserve();
      } else if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new AppError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "This Idempotency-Key was already used for a different request",
          );
        }

        if (!existing.completed_at) {
          // The original is still running. Answering now would race it.
          throw new AppError(
            "IDEMPOTENCY_REQUEST_IN_FLIGHT",
            "A request with this Idempotency-Key is still in progress. Retry shortly.",
          );
        }

        request.log.info(
          { idempotency_key: header, status: existing.response_status },
          "replaying stored idempotent response",
        );

        // Short-circuit: the handler never runs, so nothing is written twice.
        await reply
          .status(existing.response_status ?? 200)
          .header("idempotent-replay", "true")
          .send(existing.response_body ?? null);
        return reply;
      }
    }

    if (reserved) {
      request.idempotency = { rowId: reserved.id, key: header };
    }
    return undefined;
  });

  fastify.addHook("onSend", async (request, reply, payload) => {
    const state: IdempotencyState | undefined = request.idempotency;
    if (!state) return payload;

    // A server error is not an outcome worth replaying — drop the reservation
    // so the client's retry actually retries.
    if (reply.statusCode >= 500) {
      await db("idempotency_keys").where({ id: state.rowId }).del();
      return payload;
    }

    let body: string | null = null;
    if (typeof payload === "string" && payload.length > 0) {
      try {
        // Validate it is JSON before storing; anything else replays as null.
        JSON.parse(payload);
        body = payload;
      } catch {
        body = null;
      }
    }

    await db("idempotency_keys").where({ id: state.rowId }).update({
      response_status: reply.statusCode,
      response_body: body,
      completed_at: db.fn.now(),
    });

    return payload;
  });
};

declare module "fastify" {
  interface FastifyRequest {
    idempotency?: IdempotencyState;
  }
}

export default fp(idempotencyPlugin, { name: "idempotency" });
