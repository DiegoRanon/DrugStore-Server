import { z } from "zod";

import { AppError } from "./errors.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** `?limit=` and `?cursor=` per PRD §3. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Keyset cursor. Opaque to clients by design — encoding the sort key rather
 * than an offset keeps pagination stable while rows are being inserted, which
 * matters for order lists that change all day.
 */
export interface Cursor {
  /** Value of the primary sort column, ISO string or date. */
  sortValue: string;
  /** Row id, breaking ties on identical sort values. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed?.sortValue !== "string" ||
      typeof parsed?.id !== "string"
    ) {
      throw new Error("malformed");
    }
    return parsed as Cursor;
  } catch {
    throw new AppError("INVALID_CURSOR", "The pagination cursor is not valid");
  }
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Build a page from `limit + 1` rows: the extra row is the lookahead that
 * tells us whether another page exists, and is not returned.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => Cursor,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);

  return {
    data,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(toCursor(last)) : null,
  };
}
