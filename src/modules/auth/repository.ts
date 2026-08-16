import type { UserRole } from "../../core/context.js";
import { db, type QueryRunner } from "../../db/knex.js";

/**
 * Auth is the one place that deliberately does NOT extend OrgScopedRepository.
 *
 * Login, refresh, and invite redemption all run *before* an organization is
 * known — the whole point of login is to discover which organization the
 * caller belongs to. Every query here is therefore keyed by a credential
 * (email, token hash, invite code), never by a caller-supplied organization
 * id, and the organization it returns becomes the scope for everything that
 * follows.
 */

export interface UserRow {
  id: string;
  organization_id: string | null;
  role: UserRole;
  email: string;
  password_hash: string;
  phone: string | null;
  first_name: string;
  last_name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface InviteCodeRow {
  id: string;
  organization_id: string;
  code: string;
  is_active: boolean;
  expires_at: Date | null;
  redeemed_by_user_id: string | null;
  redeemed_at: Date | null;
  created_at: Date;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  rotated_from_id: string | null;
  family_id: string;
  created_at: Date;
}

export type RevokeReason =
  | "rotated"
  | "logout"
  | "reuse_detected"
  | "user_deactivated"
  | "password_changed";

export class AuthRepository {
  constructor(private readonly runner: QueryRunner = db) {}

  /** Bind this repository to an open transaction. */
  withRunner(runner: QueryRunner): AuthRepository {
    return new AuthRepository(runner);
  }

  // --- users ---------------------------------------------------------------

  async findUserByEmail(email: string): Promise<UserRow | undefined> {
    return this.runner<UserRow>("users")
      .whereRaw("lower(email) = lower(?)", [email])
      .first();
  }

  async findUserById(id: string): Promise<UserRow | undefined> {
    return this.runner<UserRow>("users").where({ id }).first();
  }

  async createUser(input: {
    organization_id: string;
    role: UserRole;
    email: string;
    password_hash: string;
    first_name: string;
    last_name: string;
    phone?: string | null;
  }): Promise<UserRow> {
    const [row] = await this.runner<UserRow>("users")
      .insert({ ...input, email: input.email.toLowerCase() })
      .returning("*");
    return row!;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.runner("users")
      .where({ id: userId })
      .update({ password_hash: passwordHash });
  }

  // --- invite codes --------------------------------------------------------

  async findInviteCode(code: string): Promise<InviteCodeRow | undefined> {
    return this.runner<InviteCodeRow>("invite_codes").where({ code }).first();
  }

  /**
   * Claims the code, returning false if another request got there first.
   *
   * The guard lives in the WHERE clause rather than in a preceding SELECT:
   * two drivers submitting the same code simultaneously would both pass a
   * read-then-write check, and PRD §4.3 requires single use.
   */
  async claimInviteCode(codeId: string, userId: string): Promise<boolean> {
    const affected = await this.runner("invite_codes")
      .where({ id: codeId })
      .whereNull("redeemed_at")
      .where({ is_active: true })
      .update({
        redeemed_by_user_id: userId,
        redeemed_at: this.runner.fn.now(),
        is_active: false,
      });
    return affected === 1;
  }

  // --- refresh tokens ------------------------------------------------------

  async insertRefreshToken(input: {
    user_id: string;
    token_hash: string;
    expires_at: Date;
    family_id: string;
    rotated_from_id?: string | null;
    user_agent?: string | null;
    ip_address?: string | null;
  }): Promise<RefreshTokenRow> {
    const [row] = await this.runner<RefreshTokenRow>("refresh_tokens")
      .insert(input)
      .returning("*");
    return row!;
  }

  async findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRow | undefined> {
    return this.runner<RefreshTokenRow>("refresh_tokens")
      .where({ token_hash: tokenHash })
      .first();
  }

  async revokeToken(id: string, reason: RevokeReason): Promise<void> {
    await this.runner("refresh_tokens")
      .where({ id })
      .whereNull("revoked_at")
      .update({ revoked_at: this.runner.fn.now(), revoked_reason: reason });
  }

  /**
   * Revokes an entire rotation chain. Used when an already-rotated token is
   * presented again: either the token was stolen or the legitimate client
   * replayed it, and neither case should leave the chain usable.
   */
  async revokeFamily(familyId: string, reason: RevokeReason): Promise<number> {
    return this.runner("refresh_tokens")
      .where({ family_id: familyId })
      .whereNull("revoked_at")
      .update({ revoked_at: this.runner.fn.now(), revoked_reason: reason });
  }

  async revokeAllForUser(
    userId: string,
    reason: RevokeReason,
  ): Promise<number> {
    return this.runner("refresh_tokens")
      .where({ user_id: userId })
      .whereNull("revoked_at")
      .update({ revoked_at: this.runner.fn.now(), revoked_reason: reason });
  }

  // --- organizations -------------------------------------------------------

  async findOrganization(id: string): Promise<
    | {
        id: string;
        name: string;
        phone: string | null;
        timezone: string;
        locale: string;
        is_active: boolean;
      }
    | undefined
  > {
    return this.runner("organizations")
      .select("id", "name", "phone", "timezone", "locale", "is_active")
      .where({ id })
      .first();
  }
}
