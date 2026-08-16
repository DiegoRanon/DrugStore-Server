import { createHash, randomBytes, randomUUID } from "node:crypto";

import { env } from "../../config/env.js";
import type { UserRole } from "../../core/context.js";

/** Claims carried by the 15-minute access token (PRD §4.2). */
export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  org_id: string;
}

/**
 * Refresh tokens are opaque random strings, not JWTs — they must be
 * revocable, and a self-contained token cannot be.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Only the hash is persisted, so a database read never yields a usable
 * credential. SHA-256 rather than Argon2 is appropriate here: the input is
 * 256 bits of entropy, so there is nothing to brute-force.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newTokenFamilyId(): string {
  return randomUUID();
}

export function refreshTokenExpiry(from: Date = new Date()): Date {
  const expires = new Date(from);
  expires.setUTCDate(expires.getUTCDate() + env.REFRESH_TOKEN_TTL_DAYS);
  return expires;
}
