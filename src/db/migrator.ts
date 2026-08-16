/**
 * Forward-only SQL migration engine.
 *
 * The hand-written .sql files in database/migrations are the source of truth
 * (PRD §2) — this decides *what* to execute and records what has run. It
 * never generates SQL.
 *
 * Takes a Knex instance rather than importing one, so the same engine runs the
 * CLI (`npm run migrate`) and the test harness against its own database.
 *
 * Two behaviours worth knowing about:
 *
 * 1. Files marked `@migration:no-transaction` run outside a transaction.
 *    PostgreSQL cannot use an enum value in the same transaction that added
 *    it, which is why 001 and 002 are each split into two files.
 *
 * 2. Baselining. The base schema already contains everything migration 001
 *    adds, so applying both to a fresh database would fail on a duplicate
 *    constraint. On first run the engine inspects the database and records
 *    already-satisfied migrations as applied instead of executing them.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Knex } from "knex";

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../database/migrations",
);

const BASE_SCHEMA_FILE = "drugstore_delivery_schema.sql";
const BASE_SCHEMA_NAME = "000_base_schema";
const NO_TRANSACTION_MARKER = "@migration:no-transaction";

export interface Migration {
  name: string;
  file: string;
  sql: string;
  runInTransaction: boolean;
  checksum: string;
}

export type Logger = (message: string) => void;

const noop: Logger = () => {};

async function ensureMigrationsTable(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(255) PRIMARY KEY,
      checksum    CHAR(64) NOT NULL,
      baselined   BOOLEAN NOT NULL DEFAULT FALSE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);

  const files = entries
    .filter((f) => f.endsWith(".sql") && f !== BASE_SCHEMA_FILE)
    // Numeric prefixes sort correctly as strings while they stay zero-padded;
    // compare the numbers so 010 does not land before 002.
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      return {
        name: path.basename(file, ".sql"),
        file,
        sql,
        runInTransaction: !sql.includes(NO_TRANSACTION_MARKER),
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

async function tableExists(db: Knex, name: string): Promise<boolean> {
  const { rows } = await db.raw("SELECT to_regclass(?) IS NOT NULL AS present", [
    `public.${name}`,
  ]);
  return rows[0]?.present === true;
}

async function constraintExists(db: Knex, name: string): Promise<boolean> {
  const { rows } = await db.raw(
    "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ?) AS present",
    [name],
  );
  return rows[0]?.present === true;
}

async function recordApplied(
  db: Knex,
  name: string,
  checksum: string,
  baselined: boolean,
): Promise<void> {
  await db.raw(
    `INSERT INTO schema_migrations (name, checksum, baselined)
     VALUES (?, ?, ?)
     ON CONFLICT (name) DO NOTHING`,
    [name, checksum, baselined],
  );
}

/**
 * Bring a database that predates this engine up to a known state without
 * re-running SQL it already contains.
 */
async function baseline(
  db: Knex,
  migrations: Migration[],
  log: Logger,
): Promise<void> {
  const { rows } = await db.raw(
    "SELECT count(*)::int AS count FROM schema_migrations",
  );
  if ((rows[0]?.count ?? 0) > 0) return;

  if (!(await tableExists(db, "orders"))) {
    // Fresh database: apply the base schema as migration 000.
    const sql = await readFile(
      path.join(MIGRATIONS_DIR, BASE_SCHEMA_FILE),
      "utf8",
    );
    log(`  applying  ${BASE_SCHEMA_NAME}`);
    await db.transaction(async (trx) => {
      await trx.raw(sql);
    });
    await recordApplied(
      db,
      BASE_SCHEMA_NAME,
      createHash("sha256").update(sql).digest("hex"),
      false,
    );
  } else {
    log(`  baseline  ${BASE_SCHEMA_NAME} (schema already present)`);
    await recordApplied(db, BASE_SCHEMA_NAME, "pre-existing", true);
  }

  // Migration 001's changes ship inside the current base schema, and an older
  // deployment may already have them. Detect rather than assume.
  if (await constraintExists(db, "chk_terminal_status_timestamp")) {
    const m001 = migrations.find((m) => m.name.startsWith("001_"));
    if (m001) {
      log(`  baseline  ${m001.name} (already present)`);
      await recordApplied(db, m001.name, m001.checksum, true);
    }
  }
}

export async function runMigrations(
  db: Knex,
  log: Logger = noop,
): Promise<number> {
  await ensureMigrationsTable(db);
  const migrations = await loadMigrations();
  await baseline(db, migrations, log);

  const applied = new Set(
    (await db<{ name: string }>("schema_migrations").select("name")).map(
      (r) => r.name,
    ),
  );
  const pending = migrations.filter((m) => !applied.has(m.name));

  if (pending.length === 0) {
    log("Migrations: nothing to apply.");
    return 0;
  }

  for (const migration of pending) {
    log(`  applying  ${migration.name}${migration.runInTransaction ? "" : " (no transaction)"}`);

    if (migration.runInTransaction) {
      await db.transaction(async (trx) => {
        await trx.raw(migration.sql);
      });
    } else {
      // Runs on the pool with no BEGIN — required for ALTER TYPE ... ADD VALUE.
      // A failure here leaves the migration unrecorded and safe to re-run,
      // since these statements are written with IF NOT EXISTS.
      await db.raw(migration.sql);
    }

    await recordApplied(db, migration.name, migration.checksum, false);
  }

  log(`Migrations: applied ${pending.length}.`);
  return pending.length;
}

export async function migrationStatus(db: Knex, log: Logger): Promise<void> {
  await ensureMigrationsTable(db);
  const migrations = await loadMigrations();
  const rows = await db<{ name: string; checksum: string; baselined: boolean }>(
    "schema_migrations",
  ).select("name", "checksum", "baselined");
  const byName = new Map(rows.map((r) => [r.name, r]));

  log("Migration status:");
  for (const name of [BASE_SCHEMA_NAME, ...migrations.map((m) => m.name)]) {
    const record = byName.get(name);
    const migration = migrations.find((m) => m.name === name);

    let state: string;
    if (!record) {
      state = "pending";
    } else if (record.baselined) {
      state = "baselined";
    } else if (migration && record.checksum !== migration.checksum) {
      // Forward-only means an applied file must never change. Editing one
      // silently desynchronizes environments.
      state = "APPLIED — FILE MODIFIED SINCE";
    } else {
      state = "applied";
    }
    log(`  ${state.padEnd(28)} ${name}`);
  }
}
