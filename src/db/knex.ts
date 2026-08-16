import knexFactory, { type Knex } from "knex";
import pg from "pg";

import { env } from "../config/env.js";

// NUMERIC comes back as a string by default so large values keep their
// precision. Money in this system is bounded by NUMERIC(12,2), well inside
// IEEE-754 safe range, and every consumer wants a number — parse it once here
// rather than in every repository.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) =>
  value === null ? null : Number(value),
);

// DATE (delivery_date) must stay a calendar date. The default parser turns it
// into a JS Date in the server's local timezone, which shifts the day for any
// server not running in the pharmacy's zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const knexConfig: Knex.Config = {
  client: "pg",
  connection: env.DATABASE_URL,
  pool: {
    min: env.DATABASE_POOL_MIN,
    max: env.DATABASE_POOL_MAX,
  },
  // Every query is parameterized; identifiers are never interpolated.
  asyncStackTraces: !env.isProduction,
};

export const db: Knex = knexFactory(knexConfig);

export type Transaction = Knex.Transaction;

/** Anything that can run a query: the pool or an open transaction. */
export type QueryRunner = Knex | Knex.Transaction;

export async function closeDb(): Promise<void> {
  await db.destroy();
}
