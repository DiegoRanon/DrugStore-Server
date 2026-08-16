import { AppError } from "./errors.js";

export type UserRole = "admin" | "driver";

/**
 * Everything the data layer needs to enforce PRD §4.4 organization isolation.
 *
 * Built by the auth plugin from JWT claims and threaded through to every
 * repository. Repositories take this as a *required* constructor argument, so
 * there is no way to construct one without an organization to scope to.
 */
export interface RequestContext {
  readonly userId: string;
  readonly role: UserRole;
  readonly organizationId: string;
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export function isAdmin(ctx: RequestContext): boolean {
  return ctx.role === "admin";
}

export function isDriver(ctx: RequestContext): boolean {
  return ctx.role === "driver";
}

export function requireAdmin(ctx: RequestContext): void {
  if (ctx.role !== "admin") {
    throw new AppError("FORBIDDEN", "This action requires an admin account");
  }
}

export function requireDriver(ctx: RequestContext): void {
  if (ctx.role !== "driver") {
    throw new AppError("FORBIDDEN", "This action requires a driver account");
  }
}
