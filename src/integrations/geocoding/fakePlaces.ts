import { AppError } from "../../core/errors.js";
import type {
  PlaceSuggestion,
  PlacesProvider,
  ResolvedPlace,
  SuggestOptions,
} from "./types.js";

/**
 * Credential-free Places provider for development and tests.
 *
 * Returns a small fixed set of Montreal addresses filtered by the typed
 * prefix, with coordinates that are real enough to route between — a few
 * kilometres apart, in a plausible order, so a fake optimization run over
 * them produces a visibly sensible sequence rather than noise.
 *
 * Deterministic on purpose: an integration test asserting a stop order needs
 * the same coordinates every run.
 */

interface FakePlace {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
}

const PLACES: FakePlace[] = [
  {
    placeId: "fake-place-notre-dame",
    primaryText: "1000 Rue Notre-Dame Ouest",
    secondaryText: "Montréal, QC, Canada",
    formattedAddress: "1000 Rue Notre-Dame O, Montréal, QC H3C 1K3, Canada",
    latitude: 45.4952,
    longitude: -73.5657,
  },
  {
    placeId: "fake-place-sainte-catherine",
    primaryText: "705 Rue Sainte-Catherine Ouest",
    secondaryText: "Montréal, QC, Canada",
    formattedAddress: "705 Rue Sainte-Catherine O, Montréal, QC H3B 4G5, Canada",
    latitude: 45.5041,
    longitude: -73.5687,
  },
  {
    placeId: "fake-place-saint-laurent",
    primaryText: "3895 Boulevard Saint-Laurent",
    secondaryText: "Montréal, QC, Canada",
    formattedAddress: "3895 Boul Saint-Laurent, Montréal, QC H2W 1X9, Canada",
    latitude: 45.5155,
    longitude: -73.5772,
  },
  {
    placeId: "fake-place-mont-royal",
    primaryText: "1200 Avenue du Mont-Royal Est",
    secondaryText: "Montréal, QC, Canada",
    formattedAddress: "1200 Av du Mont-Royal E, Montréal, QC H2J 1Y2, Canada",
    latitude: 45.5266,
    longitude: -73.5786,
  },
  {
    placeId: "fake-place-jean-talon",
    primaryText: "7070 Avenue Henri-Julien",
    secondaryText: "Montréal, QC, Canada",
    formattedAddress: "7070 Av Henri-Julien, Montréal, QC H2S 3S3, Canada",
    latitude: 45.5366,
    longitude: -73.6142,
  },
  {
    placeId: "fake-place-verdun",
    primaryText: "4000 Rue Wellington",
    secondaryText: "Verdun, QC, Canada",
    formattedAddress: "4000 Rue Wellington, Verdun, QC H4G 1V7, Canada",
    latitude: 45.4585,
    longitude: -73.5713,
  },
];

const byId = new Map(PLACES.map((place) => [place.placeId, place]));

export class FakePlacesProvider implements PlacesProvider {
  readonly name = "fake";

  async suggest(
    input: string,
    _options: SuggestOptions,
  ): Promise<PlaceSuggestion[]> {
    const term = input.trim().toLowerCase();
    if (term.length === 0) return [];

    return PLACES.filter(
      (place) =>
        place.primaryText.toLowerCase().includes(term) ||
        place.secondaryText.toLowerCase().includes(term),
    ).map((place) => ({
      placeId: place.placeId,
      primaryText: place.primaryText,
      secondaryText: place.secondaryText,
    }));
  }

  async resolve(placeId: string): Promise<ResolvedPlace> {
    const place = byId.get(placeId);
    if (!place) {
      throw new AppError("NOT_FOUND", "Address not found");
    }

    return {
      placeId: place.placeId,
      formattedAddress: place.formattedAddress,
      latitude: place.latitude,
      longitude: place.longitude,
    };
  }
}

/**
 * Always fails. Proves that a Places outage degrades to plain typed addresses
 * rather than blocking order creation — an employee with a patient on the
 * phone cannot wait for Google to come back.
 */
export class FailingPlacesProvider implements PlacesProvider {
  readonly name = "failing";

  async suggest(): Promise<PlaceSuggestion[]> {
    throw new Error("places provider unavailable");
  }

  async resolve(): Promise<ResolvedPlace> {
    throw new Error("places provider unavailable");
  }
}
