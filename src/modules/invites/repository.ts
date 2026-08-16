import { OrgScopedRepository } from "../../core/repository.js";

export interface InviteCodeRecord {
  id: string;
  organization_id: string;
  code: string;
  is_active: boolean;
  expires_at: Date | null;
  redeemed_by_user_id: string | null;
  redeemed_at: Date | null;
  created_at: Date;
}

/**
 * Admin-facing view of invite codes. Unlike AuthRepository — which reads codes
 * by their secret value before any organization is known — every query here
 * is org-scoped, so one pharmacy can never see or revoke another's codes.
 */
export class InvitesRepository extends OrgScopedRepository {
  protected readonly table = "invite_codes";

  async list(options: {
    isActive?: boolean;
    limit: number;
  }): Promise<InviteCodeRecord[]> {
    const query = this.scoped()
      .select<InviteCodeRecord[]>("*")
      .orderBy("created_at", "desc")
      .limit(options.limit);

    if (options.isActive !== undefined) {
      query.where("is_active", options.isActive);
    }
    return query;
  }

  async findById(id: string): Promise<InviteCodeRecord | undefined> {
    return this.scoped().where({ id }).first<InviteCodeRecord>();
  }

  async existsWithCode(code: string): Promise<boolean> {
    // Codes are globally unique, so this check is deliberately unscoped: a
    // collision with another organization's code still has to be avoided.
    const row = await this.unscoped().where({ code }).first("id");
    return Boolean(row);
  }

  async create(input: {
    code: string;
    expires_at: Date | null;
  }): Promise<InviteCodeRecord> {
    const [row] = await this.unscoped()
      .insert({
        organization_id: this.organizationId,
        code: input.code,
        expires_at: input.expires_at,
      })
      .returning<InviteCodeRecord[]>("*");
    return row!;
  }

  /** Deactivation is scoped and only affects codes nobody has redeemed yet. */
  async deactivate(id: string): Promise<number> {
    return this.scoped()
      .where({ id })
      .whereNull("redeemed_at")
      .update({ is_active: false });
  }
}
