import type { FastifyInstance } from "fastify";

import { env } from "../../config/env.js";
import type { RequestContext, UserRole } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { db } from "../../db/knex.js";
import {
  burnPasswordCycle,
  hashPassword,
  verifyPassword,
} from "./password.js";
import { AuthRepository, type UserRow } from "./repository.js";
import {
  assertNotThrottled,
  clearAttempts,
  recordFailedAttempt,
} from "./throttle.js";
import {
  type AccessTokenClaims,
  generateRefreshToken,
  hashRefreshToken,
  newTokenFamilyId,
  refreshTokenExpiry,
} from "./tokens.js";

export interface SessionMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuthenticatedSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
    role: UserRole;
    first_name: string;
    last_name: string;
    organization_id: string;
  };
}

export class AuthService {
  private readonly repo = new AuthRepository();

  constructor(private readonly fastify: FastifyInstance) {}

  // --- login ---------------------------------------------------------------

  /**
   * Unified login (PRD §4.2). The server determines the role from the user
   * record and returns it so the client knows which interface to route to —
   * the client never declares which kind of account it is signing into.
   */
  async login(
    email: string,
    password: string,
    meta: SessionMetadata,
  ): Promise<AuthenticatedSession> {
    await assertNotThrottled(email);

    const user = await this.repo.findUserByEmail(email);

    if (!user) {
      // Spend comparable time on a non-existent account so response timing
      // does not reveal which emails are registered.
      await burnPasswordCycle(password);
      await recordFailedAttempt(email);
      throw new AppError("INVALID_CREDENTIALS", "Incorrect email or password");
    }

    const passwordOk = await verifyPassword(user.password_hash, password);
    if (!passwordOk) {
      await recordFailedAttempt(email);
      throw new AppError("INVALID_CREDENTIALS", "Incorrect email or password");
    }

    // Checked after the password so a probe cannot distinguish "disabled"
    // from "wrong password" without valid credentials.
    if (!user.is_active) {
      await this.repo.revokeAllForUser(user.id, "user_deactivated");
      throw new AppError(
        "ACCOUNT_DISABLED",
        "This account has been deactivated. Contact your administrator.",
      );
    }

    await clearAttempts(email);
    return this.issueSession(this.repo, user, meta);
  }

  // --- token issuance ------------------------------------------------------

  private async issueSession(
    repo: AuthRepository,
    user: UserRow,
    meta: SessionMetadata,
    familyId = newTokenFamilyId(),
    rotatedFromId: string | null = null,
  ): Promise<AuthenticatedSession> {
    if (!user.organization_id) {
      // Enforced for admins by chk_admin_has_organization, and for drivers by
      // invite redemption. A user without one cannot be scoped, so there is no
      // safe session to issue.
      throw new AppError(
        "FORBIDDEN",
        "This account is not linked to an organization",
      );
    }

    const claims: AccessTokenClaims = {
      sub: user.id,
      role: user.role,
      org_id: user.organization_id,
    };

    const accessToken = this.fastify.jwt.sign(claims);
    const refreshToken = generateRefreshToken();

    await repo.insertRefreshToken({
      user_id: user.id,
      token_hash: hashRefreshToken(refreshToken),
      expires_at: refreshTokenExpiry(),
      family_id: familyId,
      rotated_from_id: rotatedFromId,
      user_agent: meta.userAgent?.slice(0, 255) ?? null,
      ip_address: meta.ipAddress ?? null,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
        organization_id: user.organization_id,
      },
    };
  }

  // --- refresh -------------------------------------------------------------

  /**
   * Rotating refresh with reuse detection.
   *
   * Presenting a token that was already rotated means either it was stolen or
   * a client replayed it. We cannot tell which, so the whole family is
   * revoked — forcing a fresh login is a far smaller cost than leaving a
   * compromised chain alive.
   */
  async refresh(
    presentedToken: string,
    meta: SessionMetadata,
  ): Promise<AuthenticatedSession> {
    const tokenHash = hashRefreshToken(presentedToken);
    const stored = await this.repo.findRefreshTokenByHash(tokenHash);

    if (!stored) {
      throw new AppError("INVALID_REFRESH_TOKEN", "Invalid refresh token");
    }

    if (stored.revoked_at) {
      await this.repo.revokeFamily(stored.family_id, "reuse_detected");
      this.fastify.log.warn(
        { family_id: stored.family_id, user_id: stored.user_id },
        "refresh token reuse detected — family revoked",
      );
      throw new AppError(
        "INVALID_REFRESH_TOKEN",
        "This session is no longer valid. Please sign in again.",
      );
    }

    if (stored.expires_at.getTime() <= Date.now()) {
      throw new AppError("INVALID_REFRESH_TOKEN", "This session has expired");
    }

    const user = await this.repo.findUserById(stored.user_id);
    if (!user || !user.is_active) {
      await this.repo.revokeFamily(stored.family_id, "user_deactivated");
      throw new AppError("ACCOUNT_DISABLED", "This account is no longer active");
    }

    // Rotation and issuance share a transaction: the old token must not be
    // revoked unless its replacement is actually persisted.
    return db.transaction(async (trx) => {
      const repo = this.repo.withRunner(trx);
      await repo.revokeToken(stored.id, "rotated");
      return this.issueSession(repo, user, meta, stored.family_id, stored.id);
    });
  }

  // --- logout --------------------------------------------------------------

  async logout(presentedToken: string): Promise<void> {
    const stored = await this.repo.findRefreshTokenByHash(
      hashRefreshToken(presentedToken),
    );
    // Silent on unknown tokens: logout is idempotent and must not confirm
    // whether a token was real.
    if (stored && !stored.revoked_at) {
      await this.repo.revokeToken(stored.id, "logout");
    }
  }

  // --- driver registration -------------------------------------------------

  /**
   * Invite-code registration (PRD §4.3). The whole redemption is one
   * transaction: if the code cannot be claimed, the user row rolls back with
   * it, so a failed race cannot leave an orphaned account.
   */
  async registerDriver(input: {
    code: string;
    email: string;
    password: string;
    first_name: string;
    last_name: string;
    phone?: string | null;
  }): Promise<{ id: string; email: string; organization_id: string }> {
    const invite = await this.repo.findInviteCode(input.code);

    if (!invite) {
      throw new AppError("INVITE_CODE_INVALID", "This invite code is not valid");
    }
    // Redemption also clears is_active, so the "already used" case must be
    // tested first — otherwise every reused code reports the vaguer
    // "not valid", and a driver who simply typed a colleague's code gets a
    // message that sends them to support instead of back to their admin.
    if (invite.redeemed_at) {
      throw new AppError(
        "INVITE_CODE_REDEEMED",
        "This invite code has already been used",
      );
    }
    if (invite.expires_at && invite.expires_at.getTime() <= Date.now()) {
      throw new AppError("INVITE_CODE_EXPIRED", "This invite code has expired");
    }
    if (!invite.is_active) {
      throw new AppError(
        "INVITE_CODE_INVALID",
        "This invite code has been deactivated",
      );
    }

    const passwordHash = await hashPassword(input.password);

    return db.transaction(async (trx) => {
      const repo = this.repo.withRunner(trx);

      const user = await repo.createUser({
        organization_id: invite.organization_id,
        role: "driver",
        email: input.email,
        password_hash: passwordHash,
        first_name: input.first_name,
        last_name: input.last_name,
        phone: input.phone ?? null,
      });

      const claimed = await repo.claimInviteCode(invite.id, user.id);
      if (!claimed) {
        // Another registration won the race between our read and this write.
        throw new AppError(
          "INVITE_CODE_REDEEMED",
          "This invite code has already been used",
        );
      }

      return {
        id: user.id,
        email: user.email,
        organization_id: user.organization_id!,
      };
    });
  }

  // --- profile -------------------------------------------------------------

  async me(ctx: RequestContext): Promise<{
    user: {
      id: string;
      email: string;
      role: UserRole;
      first_name: string;
      last_name: string;
      phone: string | null;
    };
    organization: {
      id: string;
      name: string;
      phone: string | null;
      timezone: string;
      locale: string;
    };
  }> {
    const user = await this.repo.findUserById(ctx.userId);
    if (!user || !user.is_active) {
      throw new AppError("ACCOUNT_DISABLED", "This account is no longer active");
    }

    const organization = await this.repo.findOrganization(ctx.organizationId);
    if (!organization) {
      throw new AppError("NOT_FOUND", "Organization not found");
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
        phone: user.phone,
      },
      organization: {
        id: organization.id,
        name: organization.name,
        phone: organization.phone,
        timezone: organization.timezone,
        locale: organization.locale,
      },
    };
  }

  /**
   * Changing a password revokes every other session — the common reason to
   * change one is suspecting it was compromised.
   */
  async changePassword(
    ctx: RequestContext,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.repo.findUserById(ctx.userId);
    if (!user) throw new AppError("NOT_FOUND", "User not found");

    const ok = await verifyPassword(user.password_hash, currentPassword);
    if (!ok) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Your current password is incorrect",
      );
    }

    const passwordHash = await hashPassword(newPassword);

    await db.transaction(async (trx) => {
      const repo = this.repo.withRunner(trx);
      await repo.updatePasswordHash(user.id, passwordHash);
      await repo.revokeAllForUser(user.id, "password_changed");
    });
  }
}
