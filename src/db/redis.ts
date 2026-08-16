import { Redis } from "ioredis";

import { env } from "../config/env.js";

/**
 * Shared Redis connection for login throttling and rate limiting.
 *
 * BullMQ and the Socket.IO adapter each need their own connections with
 * different options, so they call `createRedisConnection()` rather than
 * sharing this one.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

/**
 * BullMQ requires `maxRetriesPerRequest: null` on its blocking connections,
 * and the Socket.IO adapter needs separate pub/sub clients.
 */
export function createRedisConnection(
  options: { blocking?: boolean } = {},
): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: options.blocking ? null : 3,
  });
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
