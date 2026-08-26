import { createAdapter } from "@socket.io/redis-adapter";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { Server as SocketServer, type Socket } from "socket.io";

import { env } from "../config/env.js";
import { createRedisConnection } from "../db/redis.js";
import type { AccessTokenClaims } from "../modules/auth/tokens.js";
import {
  driverRoom,
  setRealtime,
  type Realtime,
  type RealtimeEvent,
  type RealtimeOrderPayload,
} from "./index.js";

/**
 * The Socket.IO layer specified in PRD §7, driver direction only.
 *
 * There is no admin fan-out here: `driver.location.updated` and
 * `order.status.changed` wait on location ingest, and the dashboard keeps
 * polling `GET /v1/orders?updated_since=` (PRD-DASHBOARD §271). Rooms are
 * per-user rather than per-org precisely because every driver in a pharmacy
 * shares an organization — an `org:` room would hand one driver another
 * driver's assignments.
 */

/** Mounted off the API prefix so a proxy can route it with the same rule. */
export const REALTIME_PATH = "/v1/realtime";

/** Bounded, so shutdown cannot hang on an unreachable Redis. */
const DRAIN_TIMEOUT_MS = 2000;

/**
 * Closes one of the adapter's Redis connections without leaving a rejection
 * behind.
 *
 * ioredis rejects every command still outstanding when a socket drops, and the
 * adapter issues its SUBSCRIBE/PSUBSCRIBE in its own constructor without
 * keeping the promises — so closing a client whose queue has not drained turns
 * an ordinary shutdown into an unhandled rejection, which Node kills the
 * process for. `npm run openapi:dump` builds an app and closes it immediately,
 * which is exactly that window.
 *
 * Redis answers one connection's commands in order, so a PING that has come
 * back proves the earlier subscribes have too and the queue is empty. PING is
 * one of the few commands a subscriber-mode connection still accepts, which is
 * what lets the same helper serve both clients.
 */
async function closeAdapterClient(client: Redis): Promise<void> {
  try {
    await Promise.race([
      client.ping(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("redis drain timed out")),
          DRAIN_TIMEOUT_MS,
        ).unref();
      }),
    ]);
  } catch {
    // Unreachable, already closed, or too slow to wait for. Nothing here is
    // worth delaying a shutdown over — the racing `ping` keeps its own
    // rejection handled either way.
  }
  client.disconnect();
}

/** `exp` is added by the signer, not by our claim type. */
type HandshakeClaims = AccessTokenClaims & { exp?: number };

interface SocketData {
  claims: HandshakeClaims;
  expiryTimer?: NodeJS.Timeout;
}

/**
 * Reads the token the client put in the handshake.
 *
 * `auth` rather than a query parameter: query strings end up in proxy and
 * server access logs, and this one is a 15-minute credential to patient
 * addresses.
 */
function handshakeToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  return typeof auth?.token === "string" && auth.token.length > 0
    ? auth.token
    : null;
}

export function attachRealtime(fastify: FastifyInstance): SocketServer {
  const io = new SocketServer(fastify.server, {
    path: REALTIME_PATH,
    // The XHR-polling fallback buys nothing here — both clients are a React
    // Native app and (later) a browser dashboard, and every hop is TLS.
    transports: ["websocket"],
    cors: {
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
      credentials: true,
    },
  });

  // Two connections, because the adapter puts one into subscriber mode and a
  // subscribed ioredis client cannot issue ordinary commands. Sharing the
  // rate-limiter's client would break rate limiting.
  const pub = createRedisConnection();
  const sub = createRedisConnection();

  /*
    Not optional. An ioredis client with no `error` listener turns a dropped
    Redis connection into Node's unhandled 'error' event, which takes the whole
    API process down with it — a realtime outage escalated into a driver who
    cannot complete a delivery, which is precisely what PRD §6 forbids of a
    dependency.

    Logged and otherwise ignored: ioredis reconnects on its own, and until it
    does, `emit` fails open and clients fall back to polling.
  */
  for (const [role, client] of [
    ["pub", pub],
    ["sub", sub],
  ] as const) {
    client.on("error", (error: Error) => {
      fastify.log.error(
        { err: error, redis_role: role },
        "realtime redis connection error",
      );
    });
  }

  io.adapter(createAdapter(pub, sub));

  /**
   * Handshake authentication.
   *
   * The same completeness check the HTTP path treats as non-negotiable
   * (src/plugins/auth.ts): a token without `org_id` cannot be scoped, so it is
   * refused rather than defaulted. A socket that fails here never joins a room
   * and never receives a frame.
   */
  io.use((socket, next) => {
    const token = handshakeToken(socket);
    if (!token) {
      next(new Error("UNAUTHENTICATED"));
      return;
    }

    let claims: HandshakeClaims;
    try {
      claims = fastify.jwt.verify<HandshakeClaims>(token);
    } catch {
      // Expired and forged are deliberately indistinguishable to the client;
      // it reconnects with a fresh token either way.
      next(new Error("UNAUTHENTICATED"));
      return;
    }

    if (!claims.sub || !claims.org_id || !claims.role) {
      next(new Error("UNAUTHENTICATED"));
      return;
    }

    (socket.data as SocketData).claims = claims;
    next();
  });

  io.on("connection", (socket) => {
    const data = socket.data as SocketData;
    const { claims } = data;

    socket.join(driverRoom(claims.sub));

    fastify.log.info(
      { user_id: claims.sub, role: claims.role, socket_id: socket.id },
      "realtime client connected",
    );

    /*
      "Connection dropped on expiry" (PRD §7). Without this a socket
      authenticated once would keep receiving frames for as long as it stayed
      open — the WebSocket equivalent of a token that never expires.

      The client's `auth` callback fetches a fresh token on every reconnect, so
      the driver sees nothing but a sub-second gap.
    */
    if (typeof claims.exp === "number") {
      const ttl = claims.exp * 1000 - Date.now();
      const timer = setTimeout(
        () => socket.disconnect(true),
        Math.max(ttl, 0),
      );
      // A pending disconnect must not hold the process open during shutdown.
      timer.unref();
      data.expiryTimer = timer;
    }

    socket.on("disconnect", () => {
      if (data.expiryTimer) clearTimeout(data.expiryTimer);
    });
  });

  const realtime: Realtime = {
    toDriver(
      driverId: string,
      event: RealtimeEvent,
      payload: RealtimeOrderPayload,
    ): void {
      io.to(driverRoom(driverId)).emit(event, payload);
    },
  };

  setRealtime(realtime);

  fastify.addHook("onClose", async () => {
    setRealtime(null);
    io.disconnectSockets(true);
    /*
      `io.engine.close()` rather than `io.close()`: the latter also closes the
      HTTP server, which Fastify is itself about to close, and the second call
      comes back ERR_SERVER_NOT_RUNNING. This tears down every socket and the
      engine while leaving the server to its owner.
    */
    io.engine.close();
    await Promise.all([closeAdapterClient(pub), closeAdapterClient(sub)]);
  });

  return io;
}
