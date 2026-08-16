import { createHash } from "node:crypto";

import { AppError } from "../../core/errors.js";
import { redis } from "../../db/redis.js";

/**
 * Failed-login throttling per PRD §4.2: 5 attempts per email per 15 minutes,
 * then exponential backoff.
 *
 * Keys are hashed rather than storing the email itself — Redis is an
 * operational cache, not a place personal information should accumulate
 * (PRD §8.6).
 */

const WINDOW_SECONDS = 15 * 60;
const FREE_ATTEMPTS = 5;
const MAX_BACKOFF_SECONDS = 60 * 60;

function keyFor(email: string): string {
  const digest = createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
  return `login:${digest}`;
}

/**
 * Backoff doubles with each further failure: 1, 2, 4… minutes, capped at an
 * hour. `attempts === FREE_ATTEMPTS` is the fifth failure, which is the one
 * PRD §4.2 says should start the backoff — so it maps to the first interval.
 */
function backoffSeconds(attempts: number): number {
  const over = attempts - FREE_ATTEMPTS;
  return Math.min(60 * 2 ** over, MAX_BACKOFF_SECONDS);
}

export async function assertNotThrottled(email: string): Promise<void> {
  const ttl = await redis.ttl(`${keyFor(email)}:blocked`);
  if (ttl > 0) {
    throw new AppError(
      "LOGIN_THROTTLED",
      "Too many failed sign-in attempts. Try again later.",
      { retry_after_seconds: ttl },
    );
  }
}

export async function recordFailedAttempt(email: string): Promise<void> {
  const key = keyFor(email);

  const results = await redis
    .multi()
    .incr(`${key}:attempts`)
    .expire(`${key}:attempts`, WINDOW_SECONDS)
    .exec();

  const attempts = Number(results?.[0]?.[1] ?? 0);

  if (attempts >= FREE_ATTEMPTS) {
    await redis.set(`${key}:blocked`, "1", "EX", backoffSeconds(attempts));
  }
}

/** Clears the counter on success so a legitimate user is not punished later. */
export async function clearAttempts(email: string): Promise<void> {
  const key = keyFor(email);
  await redis.del(`${key}:attempts`, `${key}:blocked`);
}
