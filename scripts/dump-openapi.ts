/**
 * Writes the generated OpenAPI document to `openapi.json`.
 *
 * The dashboard runs `openapi-typescript` against this file to get its request
 * and response types, so the React client cannot drift from what the server
 * actually validates. Regenerate whenever a route schema changes.
 *
 *   npm run openapi:dump
 */
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app.js";
import { closeDb } from "../src/db/knex.js";
import { closeRedis } from "../src/db/redis.js";

// Not `import.meta.dirname` — that lands in Node 20.11/21.2, and the engines
// floor here is Node 20.
const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "openapi.json",
);

const app = await buildApp();

try {
  // The generator collects routes as they register, so the app must be fully
  // ready before the document is complete.
  await app.ready();
  const spec = app.swagger();
  await writeFile(OUTPUT, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  const paths = Object.keys((spec as { paths?: object }).paths ?? {}).length;
  console.log(`Wrote ${OUTPUT} (${paths} paths)`);
} finally {
  await app.close();
  await closeDb();
  await closeRedis();
}
