/**
 * Forward-only SQL migration runner.
 *
 * The hand-written .sql files in database/migrations are the source of truth
 * (PRD §2). This runner only decides *what* to execute and records what has
 * already run — it never generates SQL.
 *
 * Two behaviours worth knowing about:
 *
 * 1. Files marked `@migration:no-transaction` run outside a transaction.
 *    PostgreSQL cannot use an enum value in the same transaction that added
 *    it, which is why 001 and 002 are each split into two files.
 *
 * 2. Baselining. The base schema already contains everything migration 001
 *    adds, so applying both to a fresh database would fail on a duplicate
 *    constraint. On first run the runner inspects the database and records
 *    already-satisfied migrations as applied instead of executing them.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { closeDb, db } from "./knex.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../database/migrations",
);

const BASE_SCHEMA_FILE = "drugstore_delivery_schema.sql";
const BASE_SCHEMA_NAME = "000_base_schema";
const NO_TRANSACTION_MARKER = "@migration:no-transaction";

interface Migration {
  name: string;
  file: string;
  sql: string;
  runInTransaction: boolean;
  checksum: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(255) PRIMARY KEY,
      checksum    CHAR(64) NOT NULL,
      baselined   BOOLEAN NOT NULL DEFAULT FALSE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function loadMigrations(): Promise<Migration[]> {
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

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.raw("SELECT to_regclass(?) IS NOT NULL AS present", [
    `public.${name}`,
  ]);
  return rows[0]?.present === true;
}

async function constraintExists(name: string): Promise<boolean> {
  const { rows } = await db.raw(
    "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ?) AS present",
    [name],
  );
  return rows[0]?.present === true;
}

async function recordApplied(
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
 * Bring a database that predates this runner up to a known state without
 * re-running SQL it already contains.
 */
async function baseline(migrations: Migration[]): Promise<void> {
  const { rows } = await db.raw("SELECT count(*)::int AS count FROM schema_migrations");
  if ((rows[0]?.count ?? 0) > 0) return;

  const ordersExists = await tableExists("orders");

  if (!ordersExists) {
    // Fresh database: apply the base schema as migration 000.
    const sql = await readFile(path.join(MIGRATIONS_DIR, BASE_SCHEMA_FILE), "utf8");
    console.log(`  applying  ${BASE_SCHEMA_NAME}`);
    await db.transaction(async (trx) => {
      await trx.raw(sql);
    });
    await recordApplied(
      BASE_SCHEMA_NAME,
      createHash("sha256").update(sql).digest("hex"),
      false,
    );
  } else {
    console.log(`  baseline  ${BASE_SCHEMA_NAME} (schema already present)`);
    await recordApplied(BASE_SCHEMA_NAME, "pre-existing", true);
  }

  // Migration 001's changes ship inside the current base schema, and an older
  // deployment may already have them. Detect rather than assume.
  const alreadyHas001 = await constraintExists("chk_terminal_status_timestamp");
  if (alreadyHas001) {
    const m001 = migrations.find((m) => m.name.startsWith("001_"));
    if (m001) {
      console.log(`  baseline  ${m001.name} (already present)`);
      await recordApplied(m001.name, m001.checksum, true);
    }
  }
}

async function appliedNames(): Promise<Set<string>> {
  const rows = await db<{ name: string }>("schema_migrations").select("name");
  return new Set(rows.map((r) => r.name));
}

async function up(): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  await baseline(migrations);

  const applied = await appliedNames();
  const pending = migrations.filter((m) => !applied.has(m.name));

  if (pending.length === 0) {
    console.log("Migrations: nothing to apply.");
    return;
  }

  for (const migration of pending) {
    const mode = migration.runInTransaction ? "" : " (no transaction)";
    console.log(`  applying  ${migration.name}${mode}`);

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

    await recordApplied(migration.name, migration.checksum, false);
  }

  console.log(`Migrations: applied ${pending.length}.`);
}

async function status(): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  const rows = await db<{ name: string; checksum: string; baselined: boolean }>(
    "schema_migrations",
  ).select("name", "checksum", "baselined");
  const byName = new Map(rows.map((r) => [r.name, r]));

  console.log("Migration status:");
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
    console.log(`  ${state.padEnd(28)} ${name}`);
  }
}

const command = process.argv[2] ?? "up";

try {
  if (command === "up") {
    await up();
  } else if (command === "status") {
    await status();
  } else {
    console.error(`Unknown command "${command}". Use "up" or "status".`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
