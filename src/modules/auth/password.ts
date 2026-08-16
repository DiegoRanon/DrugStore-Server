import { Algorithm, hash, verify } from "@node-rs/argon2";

/**
 * Argon2id parameters per PRD §4.2, using the OWASP baseline
 * (m=19 MiB, t=2, p=1).
 *
 * These values are embedded in the resulting hash string, so raising them
 * later does not invalidate existing passwords — verification reads the
 * parameters from the stored hash.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, OPTIONS);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as
    // an error that a caller might mistake for success.
    return false;
  }
}

/**
 * Constant-ish work performed when an email does not exist, so that a failed
 * login takes comparable time whether or not the account is real. Without
 * this, response timing enumerates valid accounts.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9vYmFyYmF6cXV4Y29ycmVjdGhvcnNlYmF0dGVyeQ";

export async function burnPasswordCycle(plaintext: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plaintext);
}
