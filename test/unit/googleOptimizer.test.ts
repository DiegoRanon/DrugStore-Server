import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return "test-token";
    }
  },
}));

const { GoogleRouteOptimizer } = await import(
  "../../src/integrations/routing/googleOptimizer.js"
);

/**
 * The payload shape is the whole test.
 *
 * Route Optimization takes a bare `google.type.LatLng` for locations, while
 * the Routes API next door takes a Waypoint wrapping one in `latLng`. Sending
 * the wrong one is a 400 the service converts into `degraded: true`, so the
 * failure reaches a pharmacy as "le service d'optimisation est indisponible"
 * and nothing points at the request that caused it.
 */
describe("GoogleRouteOptimizer request shape", () => {
  let sent: any;

  beforeEach(() => {
    sent = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        sent = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            routes: [{ visits: [{ shipmentIndex: 1 }, { shipmentIndex: 0 }] }],
          }),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const request = {
    depot: { latitude: 14.6, longitude: -61.07 },
    stops: [
      {
        orderId: "a",
        address: "1 rue A",
        location: { latitude: 14.6415, longitude: -61.0242 },
        isPriority: false,
      },
      {
        orderId: "b",
        address: "2 rue B",
        location: { latitude: 14.61, longitude: -61.05 },
        isPriority: false,
      },
    ],
  };

  it("sends bare LatLng objects, never a latLng wrapper", async () => {
    const optimizer = new GoogleRouteOptimizer({ projectId: "p" });
    await optimizer.optimize(request as never);

    const delivery = sent.model.shipments[0].deliveries[0];
    expect(delivery.arrivalLocation).toEqual({
      latitude: 14.6415,
      longitude: -61.0242,
    });
    expect(delivery.arrivalLocation).not.toHaveProperty("latLng");

    const vehicle = sent.model.vehicles[0];
    expect(vehicle.startLocation).toEqual({ latitude: 14.6, longitude: -61.07 });
    expect(vehicle.endLocation).toEqual({ latitude: 14.6, longitude: -61.07 });

    expect(JSON.stringify(sent)).not.toContain("latLng");
  });

  it("returns the solver's order", async () => {
    const optimizer = new GoogleRouteOptimizer({ projectId: "p" });
    const result = await optimizer.optimize(request as never);

    expect(result.orderedOrderIds).toEqual(["b", "a"]);
    expect(result.degraded).toBe(false);
  });
});
