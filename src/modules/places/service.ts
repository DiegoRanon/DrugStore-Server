import type { FastifyBaseLogger } from "fastify";

import type { RequestContext } from "../../core/context.js";
import { AppError } from "../../core/errors.js";
import { getPlacesProvider } from "../../integrations/geocoding/index.js";
import { OrdersRepository } from "../orders/repository.js";

/**
 * Address standardization for the dashboard's order and patient forms.
 *
 * The dashboard cannot call Google directly — its CSP is `connect-src 'self'`
 * and it holds no API key — so every suggestion an employee sees comes
 * through here. That is a deliberate arrangement rather than an obstacle: it
 * keeps the key in one place, and it means an employee typing a patient's
 * address is not broadcasting keystrokes to a third party from a browser we
 * do not control.
 *
 * WHAT IS AND IS NOT LOGGED
 *
 * The query string is a patient's address being typed one character at a
 * time. It never reaches a log line here, and `*.address` /
 * `*.formatted_address` are redacted globally besides. Failures log the
 * provider and the error, never the input.
 */
export class PlacesService {
  private readonly orders: OrdersRepository;

  constructor(
    private readonly ctx: RequestContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.orders = new OrdersRepository(ctx);
  }

  /**
   * Suggestions for a partial address, biased toward the pharmacy.
   *
   * A provider outage returns an empty list rather than an error. The address
   * field stays typeable either way, and an employee with a patient on the
   * phone should not be blocked from taking the order because Google is
   * having an afternoon — the order simply saves without coordinates and is
   * appended to the route instead of placed in it.
   */
  async suggest(
    input: string,
    sessionToken: string,
  ): Promise<
    { place_id: string; primary_text: string; secondary_text: string }[]
  > {
    const provider = getPlacesProvider();
    const org = await this.orders.findOrganizationRouting();

    try {
      const suggestions = await provider.suggest(input, {
        sessionToken,
        origin:
          org.latitude !== null && org.longitude !== null
            ? { latitude: org.latitude, longitude: org.longitude }
            : undefined,
      });

      return suggestions.map((suggestion) => ({
        place_id: suggestion.placeId,
        primary_text: suggestion.primaryText,
        secondary_text: suggestion.secondaryText,
      }));
    } catch (error) {
      this.log.warn(
        { err: error, provider: provider.name },
        "address autocomplete failed — returning no suggestions",
      );
      return [];
    }
  }

  /**
   * Turns a chosen suggestion into an address and a coordinate.
   *
   * This one does fail loudly. It runs after a deliberate human choice, and
   * silently returning nothing would leave the employee looking at a form
   * that will not fill in with no indication why.
   */
  async resolve(
    placeId: string,
    sessionToken: string,
  ): Promise<{
    place_id: string;
    formatted_address: string;
    latitude: number;
    longitude: number;
  }> {
    const provider = getPlacesProvider();

    try {
      const place = await provider.resolve(placeId, sessionToken);
      return {
        place_id: place.placeId,
        formatted_address: place.formattedAddress,
        latitude: place.latitude,
        longitude: place.longitude,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;

      this.log.error(
        { err: error, provider: provider.name },
        "address resolution failed",
      );
      throw new AppError(
        "DEPENDENCY_UNAVAILABLE",
        "The address service is unavailable. You can still enter the address by hand.",
      );
    }
  }
}
