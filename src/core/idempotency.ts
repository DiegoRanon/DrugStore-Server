import { createHash } from "node:crypto";

/**
 * Support for the `Idempotency-Key` header (PRD §3).
 *
 * The driver app runs on flaky mobile networks and retries. Without this, a
 * retried "complete delivery" writes a second status event, and a retried
 * payment records a second collection — both of which corrupt reporting in
 * ways that are hard to detect after the fact.
 *
 * Backed by Postgres rather than Redis on purpose: whether a delivery was
 * recorded twice must not depend on a cache surviving.
 */

export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Key order in a JSON object is not significant, but `JSON.stringify` output
 * depends on it — so two semantically identical retries would fingerprint
 * differently and be rejected as a conflict. Sorting keys makes the
 * fingerprint depend on meaning rather than serialization order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Identifies the request a key was first used for. A retry that reuses the key
 * with a different payload is a client bug, and answering it with the earlier
 * response would silently do the wrong thing — so it is refused instead.
 */
export function requestFingerprint(input: {
  method: string;
  url: string;
  body: unknown;
}): string {
  return createHash("sha256")
    .update(`${input.method}\n${input.url}\n${stableStringify(input.body ?? null)}`)
    .digest("hex");
}

export function idempotencyExpiry(from: Date = new Date()): Date {
  const expires = new Date(from);
  expires.setUTCHours(expires.getUTCHours() + IDEMPOTENCY_TTL_HOURS);
  return expires;
}
