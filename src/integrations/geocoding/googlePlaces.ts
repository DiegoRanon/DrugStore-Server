import { AppError } from "../../core/errors.js";
import { fetchJson } from "../http.js";
import type {
  PlaceSuggestion,
  PlacesProvider,
  ResolvedPlace,
  SuggestOptions,
} from "./types.js";

/**
 * Google Places API (New) adapter.
 *
 * Two calls, one session. `places:autocomplete` runs on every debounced
 * keystroke; `places/{id}` runs once when the employee picks one. Passing the
 * same session token through both is what makes Google bill the burst as a
 * single autocomplete session instead of per request.
 *
 * The field mask on the details call is not an optimization — Places bills by
 * SKU according to which fields are requested, and asking for the whole place
 * object to read three fields off it costs several times more per lookup.
 */

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";

/** Bias radius around the pharmacy, in metres. Wide enough for a delivery
 *  territory, tight enough that a same-named street two provinces away does
 *  not outrank the one down the block. */
const BIAS_RADIUS_METERS = 30_000;

interface AutocompleteResponse {
  suggestions?: {
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }[];
}

interface DetailsResponse {
  id?: string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

export interface GooglePlacesConfig {
  apiKey: string;
  /**
   * Restricts suggestions to these ISO 3166-1 alpha-2 regions. The pharmacy
   * delivers in one country; offering addresses from another is noise that
   * can only ever be picked by mistake.
   */
  regionCodes?: string[];
  /** BCP-47, so suggestions come back in the employee's language. */
  languageCode?: string;
}

export class GooglePlacesProvider implements PlacesProvider {
  readonly name = "google";

  constructor(private readonly config: GooglePlacesConfig) {}

  private get headers(): Record<string, string> {
    return { "X-Goog-Api-Key": this.config.apiKey };
  }

  async suggest(
    input: string,
    options: SuggestOptions,
  ): Promise<PlaceSuggestion[]> {
    const trimmed = input.trim();
    if (trimmed.length === 0) return [];

    const response = await fetchJson<AutocompleteResponse>(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: this.headers,
      body: {
        input: trimmed,
        sessionToken: options.sessionToken,
        languageCode: this.config.languageCode,
        includedRegionCodes: this.config.regionCodes,
        // Addresses only. Without this the list fills with businesses and
        // landmarks, which are not places a package gets delivered to.
        includedPrimaryTypes: ["street_address", "premise", "subpremise"],
        ...(options.origin
          ? {
              locationBias: {
                circle: {
                  center: {
                    latitude: options.origin.latitude,
                    longitude: options.origin.longitude,
                  },
                  radius: BIAS_RADIUS_METERS,
                },
              },
            }
          : {}),
      },
    });

    return (response.suggestions ?? [])
      .map((suggestion) => suggestion.placePrediction)
      .filter((prediction) => prediction?.placeId)
      .map((prediction) => ({
        placeId: prediction!.placeId!,
        primaryText:
          prediction!.structuredFormat?.mainText?.text ??
          prediction!.text?.text ??
          "",
        secondaryText: prediction!.structuredFormat?.secondaryText?.text ?? "",
      }));
  }

  async resolve(placeId: string, sessionToken: string): Promise<ResolvedPlace> {
    const url = new URL(`${DETAILS_URL}/${encodeURIComponent(placeId)}`);
    url.searchParams.set("sessionToken", sessionToken);
    if (this.config.languageCode) {
      url.searchParams.set("languageCode", this.config.languageCode);
    }

    const response = await fetchJson<DetailsResponse>(url.toString(), {
      headers: {
        ...this.headers,
        "X-Goog-FieldMask": "id,formattedAddress,location",
      },
    });

    const latitude = response.location?.latitude;
    const longitude = response.location?.longitude;

    // A place with no coordinate is useless to us and would violate the
    // paired-coordinate constraint on the way in. Refuse it here, where the
    // employee can still pick a different suggestion.
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !response.formattedAddress
    ) {
      throw new AppError(
        "DEPENDENCY_UNAVAILABLE",
        "That address could not be resolved to a location",
      );
    }

    return {
      placeId: response.id ?? placeId,
      formattedAddress: response.formattedAddress,
      latitude,
      longitude,
    };
  }
}
