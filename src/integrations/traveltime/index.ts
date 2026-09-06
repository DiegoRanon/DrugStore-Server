import { env } from "../../config/env.js";
import { FakeTravelTimeProvider } from "./fakeTravelTime.js";
import { GoogleRoutesProvider } from "./googleRoutes.js";
import type { TravelTimeProvider } from "./types.js";

export * from "./types.js";
export {
  FailingTravelTimeProvider,
  FakeTravelTimeProvider,
} from "./fakeTravelTime.js";
export { GoogleRoutesProvider } from "./googleRoutes.js";

let instance: TravelTimeProvider | null = null;

/**
 * Selects the travel-time provider from configuration.
 *
 * `TRAVEL_TIME=googlemaps` needs only `GOOGLE_MAPS_API_KEY` — the Routes API
 * takes the same plain key as Places, not the service account the Route
 * Optimization API requires. A pharmacy blocked from creating service-account
 * keys can therefore have working ETAs without having working optimization.
 */
export function getTravelTimeProvider(): TravelTimeProvider {
  if (instance) return instance;

  instance =
    env.TRAVEL_TIME === "googlemaps"
      ? new GoogleRoutesProvider({
          apiKey: env.GOOGLE_MAPS_API_KEY!,
          languageCode: env.GEOCODE_LANGUAGE,
        })
      : new FakeTravelTimeProvider();

  return instance;
}

/** Test seam for injecting a specific provider. */
export function setTravelTimeProvider(provider: TravelTimeProvider | null): void {
  instance = provider;
}
