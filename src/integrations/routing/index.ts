import { env } from "../../config/env.js";
import { FakeOptimizer } from "./fakeOptimizer.js";
import { GoogleRouteOptimizer } from "./googleOptimizer.js";
import type { RouteOptimizer } from "./types.js";

export * from "./types.js";
export { FailingOptimizer, FakeOptimizer } from "./fakeOptimizer.js";
export { GoogleRouteOptimizer } from "./googleOptimizer.js";

let instance: RouteOptimizer | null = null;

/**
 * Selects the optimizer from configuration.
 *
 * `googlemaps` requires a project id, validated at boot (config/env.ts). The
 * service-account key is optional: without one the client uses Application
 * Default Credentials, which is the better arrangement anyway and the only one
 * available to projects where key creation is blocked by org policy.
 *
 * `mapbox` remains accepted and still falls back to the fake with a warning.
 * The Mapbox adapter was never written — Google Route Optimization took its
 * place — and removing the value would break any environment still setting it
 * for no gain.
 */
export function getRouteOptimizer(): RouteOptimizer {
  if (instance) return instance;

  if (env.ROUTE_OPTIMIZER === "mapbox") {
    console.warn(
      "ROUTE_OPTIMIZER=mapbox has no adapter (superseded by ROUTE_OPTIMIZER=googlemaps); using the fake optimizer.",
    );
  }

  instance =
    env.ROUTE_OPTIMIZER === "googlemaps"
      ? new GoogleRouteOptimizer({
          projectId: env.GOOGLE_CLOUD_PROJECT_ID!,
          credentialsJson: env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
        })
      : new FakeOptimizer();

  return instance;
}

/** Test seam for injecting a specific optimizer. */
export function setRouteOptimizer(optimizer: RouteOptimizer | null): void {
  instance = optimizer;
}
