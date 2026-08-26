import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { closeDb } from "./db/knex.js";
import { closeRedis } from "./db/redis.js";

const app = await buildApp();

/**
 * Drain in-flight requests before tearing down connections. A driver mid-way
 * through completing a delivery should not lose that write to a deploy.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    await closeDb();
    await closeRedis();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

try {
  // `::` rather than `0.0.0.0`: a dual-stack listener serves the public proxy
  // over IPv4 and is also reachable on the platform's private network, which
  // on Railway is IPv6-only. Binding IPv4-only would make the dashboard's
  // `http://api.railway.internal:3000` calls fail while curl kept working.
  await app.listen({ port: env.PORT, host: "::" });
} catch (error) {
  app.log.error({ err: error }, "failed to start");
  process.exit(1);
}
