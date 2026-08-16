import { randomInt } from "node:crypto";

import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { InvitesRepository, type InviteCodeRecord } from "./repository.js";

/**
 * Omits I, O, 0, 1 — drivers type these by hand off a printed sheet, and the
 * ambiguous glyphs are the ones that generate support calls.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const MAX_GENERATION_ATTEMPTS = 5;

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

export interface InviteCodeView {
  id: string;
  code: string;
  is_active: boolean;
  expires_at: string | null;
  redeemed_at: string | null;
  created_at: string;
}

function toView(row: InviteCodeRecord): InviteCodeView {
  return {
    id: row.id,
    code: row.code,
    is_active: row.is_active,
    expires_at: row.expires_at?.toISOString() ?? null,
    redeemed_at: row.redeemed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export class InvitesService {
  private readonly repo: InvitesRepository;

  constructor(private readonly ctx: RequestContext) {
    this.repo = new InvitesRepository(ctx);
  }

  async create(expiresAt?: Date): Promise<InviteCodeView> {
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Expiry must be in the future",
        { field: "expires_at" },
      );
    }

    // 32^8 ≈ 10^12 keeps collisions vanishingly rare, but the codes are
    // globally unique in the database, so retry rather than fail on the
    // unlucky case.
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const code = generateCode();
      if (await this.repo.existsWithCode(code)) continue;

      const row = await this.repo.create({
        code,
        expires_at: expiresAt ?? null,
      });
      return toView(row);
    }

    throw new AppError(
      "INTERNAL_ERROR",
      "Could not generate a unique invite code",
    );
  }

  async list(options: {
    isActive?: boolean;
    limit: number;
  }): Promise<InviteCodeView[]> {
    const rows = await this.repo.list(options);
    return rows.map(toView);
  }

  async deactivate(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new AppError("NOT_FOUND", "Invite code not found");

    if (existing.redeemed_at) {
      throw new AppError(
        "INVITE_CODE_REDEEMED",
        "This code has already been redeemed and cannot be deactivated",
      );
    }

    await this.repo.deactivate(id);
  }
}
