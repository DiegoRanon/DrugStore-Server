import type {
  OptimizeRequest,
  OptimizeResult,
  RouteOptimizer,
} from "./types.js";

/**
 * Credential-free optimizer for development and tests.
 *
 * Sorts stops by address so the result is deterministic and visibly different
 * from insertion order — enough to prove the sequencing pipeline works end to
 * end without pretending to be a real solver.
 */
export class FakeOptimizer implements RouteOptimizer {
  readonly name = "fake";

  async optimize(request: OptimizeRequest): Promise<OptimizeResult> {
    const ordered = [...request.stops].sort((a, b) =>
      a.address.localeCompare(b.address, "en", { numeric: true }),
    );

    return {
      orderedOrderIds: ordered.map((stop) => stop.orderId),
      degraded: false,
      provider: this.name,
    };
  }
}

/**
 * Always fails. Used by the test suite to prove the graceful-degradation path
 * of PRD §5.4: a provider outage must leave the driver with a working queue.
 */
export class FailingOptimizer implements RouteOptimizer {
  readonly name = "failing";

  async optimize(): Promise<OptimizeResult> {
    throw new Error("route optimizer unavailable");
  }
}
