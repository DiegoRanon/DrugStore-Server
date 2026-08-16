import { defineConfig } from "vitest/config";

/**
 * Integration tests run against a real PostgreSQL database, not mocks.
 *
 * PRD §10 makes the order state machine, organization isolation, and the
 * driver PII serializers non-negotiable to test — and all three are enforced
 * partly by database constraints, transactions, and row locks. Mocking the
 * database would test the mock.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://drugstore:drugstore@localhost:5433/drugstore_test";

export default defineConfig({
  test: {
    globalSetup: ["./test/setup/globalSetup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: "silent",
      JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
      INTERNAL_API_TOKEN: "test-internal-token-value",
    },
    // Tests share one database and truncate between cases, so they must not
    // run concurrently against each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
