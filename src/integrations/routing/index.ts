import { env } from "../../config/env.js";
import { FakeOptimizer } from "./fakeOptimizer.js";
import type { RouteOptimizer } from "./types.js";

export * from "./types.js";
export { FailingOptimizer, FakeOptimizer } from "./fakeOptimizer.js";

let instance: RouteOptimizer | null = null;

/**
 * Selects the optimizer from configuration. `ROUTE_OPTIMIZER=mapbox` is
 * accepted by the environment schema already; the Mapbox adapter itself lands
 * in Phase 5, so until then it falls back to the fake with a loud warning
 * rather than crashing a deploy.
 */
export function getRouteOptimizer(): RouteOptimizer {
  if (instance) return instance;

  if (env.ROUTE_OPTIMIZER === "mapbox") {
    console.warn(
      "ROUTE_OPTIMIZER=mapbox is configured but the Mapbox adapter ships in Phase 5; using the fake optimizer.",
    );
  }

  instance = new FakeOptimizer();
  return instance;
}

/** Test seam for injecting a specific optimizer. */
export function setRouteOptimizer(optimizer: RouteOptimizer | null): void {
  instance = optimizer;
}
