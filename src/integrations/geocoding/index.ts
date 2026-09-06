import { env } from "../../config/env.js";
import { FakePlacesProvider } from "./fakePlaces.js";
import { GooglePlacesProvider } from "./googlePlaces.js";
import type { PlacesProvider } from "./types.js";

export * from "./types.js";
export { FailingPlacesProvider, FakePlacesProvider } from "./fakePlaces.js";
export { GooglePlacesProvider } from "./googlePlaces.js";

let instance: PlacesProvider | null = null;

/**
 * Selects the Places provider from configuration.
 *
 * `GEOCODER=googlemaps` is validated at boot to have its API key (see
 * config/env.ts), so reaching this with a missing credential is impossible
 * rather than merely unlikely.
 */
export function getPlacesProvider(): PlacesProvider {
  if (instance) return instance;

  instance =
    env.GEOCODER === "googlemaps"
      ? new GooglePlacesProvider({
          apiKey: env.GOOGLE_MAPS_API_KEY!,
          regionCodes: env.GEOCODE_COUNTRY,
          languageCode: env.GEOCODE_LANGUAGE,
        })
      : new FakePlacesProvider();

  return instance;
}

/** Test seam for injecting a specific provider. */
export function setPlacesProvider(provider: PlacesProvider | null): void {
  instance = provider;
}
