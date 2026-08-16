/**
 * CLI wrapper around the migration engine.
 *
 *   npm run migrate           apply everything pending
 *   npm run migrate:status    show what has and has not run
 */
import { closeDb, db } from "./knex.js";
import { migrationStatus, runMigrations } from "./migrator.js";

const log = (message: string): void => {
  console.log(message);
};

const command = process.argv[2] ?? "up";

try {
  if (command === "up") {
    await runMigrations(db, log);
  } else if (command === "status") {
    await migrationStatus(db, log);
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
