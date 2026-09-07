import type { FastifyBaseLogger } from "fastify";

import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { OrganizationsRepository, type OrganizationRow } from "./repository.js";
import type { UpdateOrganizationBody } from "./schemas.js";

/**
 * The pharmacy's own profile — currently just its address and depot
 * coordinate.
 *
 * WHY THIS MODULE EXISTS
 *
 * `organizations.latitude/longitude` is the depot the route optimizer starts
 * from and returns to. The columns shipped in migration 014 with no writer:
 * organization creation (`internal/routes.ts`) stores a free-text address and
 * no geocode, and its PATCH covers rates and windows only. The result was a
 * depot that was always NULL, so routes were solved as open tours and every
 * driver ETA degraded with "the organization has no coordinates to start
 * from". This closes that gap.
 */
export class OrganizationsService {
  private readonly repo: OrganizationsRepository;

  constructor(
    ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.repo = new OrganizationsRepository(ctx);
  }

  async get(): Promise<OrganizationRow> {
    const row = await this.repo.find();
    if (!row) throw new AppError("NOT_FOUND", "Organization not found");
    return row;
  }

  /**
   * Writes the address and its geocode as one unit.
   *
   * The geocode travels with the address it came from, exactly as it does on
   * an order: sending an address without geocode fields clears the
   * coordinate rather than leaving a stale one behind. A depot pointing at
   * the pharmacy's previous building is worse than no depot, because nothing
   * in the route output would look wrong.
   */
  async update(body: UpdateOrganizationBody): Promise<OrganizationRow> {
    const patch: Partial<OrganizationRow> = {};

    if (body.address !== undefined) patch.address = body.address;

    const touchesGeocode =
      body.place_id !== undefined ||
      body.formatted_address !== undefined ||
      body.latitude !== undefined ||
      body.longitude !== undefined ||
      body.address !== undefined;

    if (touchesGeocode) {
      patch.place_id = body.place_id ?? null;
      patch.formatted_address = body.formatted_address ?? null;
      patch.latitude = body.latitude ?? null;
      patch.longitude = body.longitude ?? null;
      patch.geocoded_at = body.latitude != null ? new Date() : null;
    }

    const row = await this.repo.update(patch);
    if (!row) throw new AppError("NOT_FOUND", "Organization not found");

    // Worth a line in the log: this is the value that decides whether every
    // route that day is anchored at the pharmacy. The address itself is
    // redacted globally, so only the presence of a coordinate is recorded.
    this.log.info(
      { has_depot: row.latitude !== null },
      "organization address updated",
    );

    return row;
  }
}
