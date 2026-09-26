import knexFactory from "knex";
import pg from "pg";

import { runMigrations } from "../../src/db/migrator.js";

/**
 * Creates the test database if it does not exist and brings it up to the
 * current schema. Runs once per `vitest` invocation, before any test file.
 *
 * The database is created rather than reused from development, so a test run
 * can never truncate real local data.
 */
export default async function globalSetup(): Promise<void> {
  const testUrl =
    process.env.TEST_DATABASE_URL ??
    "postgres://medibus:medibus@localhost:5433/medibus_test";

  const parsed = new URL(testUrl);
  const dbName = parsed.pathname.replace(/^\//, "");

  // CREATE DATABASE cannot run inside a transaction or against the database
  // being created, so connect to the maintenance database first.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });

  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL at ${adminUrl.host}. Start it with ` +
        `\`docker compose up -d\`.\n${(error as Error).message}`,
    );
  }

  const { rowCount } = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [dbName],
  );
  if (rowCount === 0) {
    // Identifier cannot be parameterized; the name comes from our own config,
    // and quoting prevents anything surprising in it from executing.
    await admin.query(`CREATE DATABASE "${dbName}"`);
  }
  await admin.end();

  const db = knexFactory({ client: "pg", connection: testUrl });
  try {
    await runMigrations(db);
  } finally {
    await db.destroy();
  }
}
