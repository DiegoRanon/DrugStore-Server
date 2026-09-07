import { describe, expect, it } from "vitest";

import { updateOrganizationBodySchema } from "../../src/modules/organizations/schemas.js";

/**
 * The depot is the one coordinate in the system a human types on purpose, and
 * half of one routes the whole pharmacy into the Gulf of Guinea. The database
 * has a paired-coordinate CHECK behind this; these cases keep the caller
 * getting a field error instead of a constraint violation.
 */
describe("updateOrganizationBodySchema", () => {
  const address = "1 rue Victor Hugo, Fort-de-France";

  it("accepts an address with a complete geocode", () => {
    const parsed = updateOrganizationBodySchema.safeParse({
      address,
      place_id: "ChIJ123",
      formatted_address: address,
      latitude: 14.6015,
      longitude: -61.0742,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a hand-typed address with no geocode at all", () => {
    const parsed = updateOrganizationBodySchema.safeParse({ address });
    expect(parsed.success).toBe(true);
  });

  it("rejects half a coordinate", () => {
    const parsed = updateOrganizationBodySchema.safeParse({
      address,
      latitude: 14.6015,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["longitude"]);
    }
  });

  it("rejects an empty patch", () => {
    expect(updateOrganizationBodySchema.safeParse({}).success).toBe(false);
  });

  it("rejects a coordinate outside the world", () => {
    const parsed = updateOrganizationBodySchema.safeParse({
      address,
      latitude: 91,
      longitude: -61.0742,
    });

    expect(parsed.success).toBe(false);
  });
});
