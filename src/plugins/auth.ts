import fastifyJwt from "@fastify/jwt";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import fp from "fastify-plugin";

import { env } from "../config/env.js";
import type { RequestContext, UserRole } from "../core/context.js";
import { AppError } from "../core/errors.js";
import type { AccessTokenClaims } from "../modules/auth/tokens.js";

/**
 * Turns a verified access token into the RequestContext that the data layer
 * requires. This is the only place a RequestContext is built from a token, so
 * organization identity always comes from a signed claim and never from a
 * request body, query string, or header.
 */
function buildContext(
  request: FastifyRequest,
  claims: AccessTokenClaims,
): RequestContext {
  return {
    userId: claims.sub,
    role: claims.role,
    organizationId: claims.org_id,
    requestId: request.requestId,
    ipAddress: request.ip ?? null,
    userAgent: request.headers["user-agent"]?.slice(0, 255) ?? null,
  };
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.ACCESS_TOKEN_TTL_SECONDS },
  });

  /** preHandler for any route that requires a logged-in user. */
  const authenticate: preHandlerHookHandler = async (request) => {
    let claims: AccessTokenClaims;
    try {
      claims = await request.jwtVerify<AccessTokenClaims>();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "FAST_JWT_EXPIRED") {
        throw new AppError("TOKEN_EXPIRED", "Your session has expired");
      }
      throw new AppError("UNAUTHENTICATED", "Authentication required");
    }

    // A token missing org_id cannot be scoped, and an unscoped query is the
    // one failure mode PRD §4.4 calls non-negotiable. Refuse rather than
    // fall back to anything.
    if (!claims.sub || !claims.org_id || !claims.role) {
      throw new AppError("UNAUTHENTICATED", "Malformed access token");
    }

    request.ctx = buildContext(request, claims);
  };

  fastify.decorate("authenticate", authenticate);

  /**
   * Role gate. Runs after `authenticate`, which must be listed first in the
   * route's preHandler array.
   */
  fastify.decorate("requireRole", (role: UserRole): preHandlerHookHandler => {
    return async (request) => {
      if (request.ctx.role !== role) {
        throw new AppError(
          "FORBIDDEN",
          `This action requires a ${role} account`,
        );
      }
    };
  });

  /**
   * Guard for /v1/internal/*. A static service token, compared in constant
   * time, entirely separate from user JWTs — these routes provision
   * organizations and admins and must never be reachable with a user session.
   */
  fastify.decorate(
    "requireInternalToken",
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const header = request.headers.authorization;
      const presented = header?.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : "";

      const expected = env.INTERNAL_API_TOKEN;
      const presentedBuf = Buffer.from(presented);
      const expectedBuf = Buffer.from(expected);

      const { timingSafeEqual } = await import("node:crypto");
      const ok =
        presentedBuf.length === expectedBuf.length &&
        timingSafeEqual(presentedBuf, expectedBuf);

      if (!ok) {
        throw new AppError("UNAUTHENTICATED", "Invalid internal API token");
      }
    },
  );
};

declare module "fastify" {
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    requireRole: (role: UserRole) => preHandlerHookHandler;
    requireInternalToken: preHandlerHookHandler;
  }

  interface FastifyRequest {
    /**
     * Present on every authenticated route. Accessing it on a public route is
     * a programming error — the type is non-optional deliberately, so that
     * forgetting the `authenticate` preHandler surfaces as an immediate crash
     * in tests rather than as a silently unscoped query.
     */
    ctx: RequestContext;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenClaims;
    user: AccessTokenClaims;
  }
}

export default fp(authPlugin, {
  name: "auth",
  dependencies: ["request-id"],
});
