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

/**
 * The model's global window.
 *
 * The solver rejects a visit window that falls outside the model's global one,
 * and defaults that global window to a span beginning at the Unix epoch. So an
 * omitted global window is not a neutral default: it fails every request that
 * carries a real delivery promise with `outside global time window`, which the
 * service converts into `degraded: true`. Since practically every order has a
 * promise — an explicit range, a requested time, or the organization's AM/PM
 * window — this failed the whole feature while looking like a provider outage.
 */
describe("GoogleRouteOptimizer global time window", () => {
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
          json: async () => ({ routes: [{ visits: [] }] }),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stop = (orderId: string, window?: { start: string; end: string }) => ({
    orderId,
    address: `${orderId} rue Test`,
    location: { latitude: 45.5, longitude: -73.6 },
    isPriority: false,
    ...(window ? { timeWindow: window } : {}),
  });

  const PM = {
    start: "2026-09-09T17:00:00.000Z",
    end: "2026-09-09T21:00:00.000Z",
  };
  const AM = {
    start: "2026-09-09T13:00:00.000Z",
    end: "2026-09-09T16:00:00.000Z",
  };

  it("spans every promise in the run", async () => {
    const optimizer = new GoogleRouteOptimizer({ projectId: "p" });
    await optimizer.optimize({ stops: [stop("a", PM), stop("b", AM)] } as never);

    // Earliest start and latest end, so no shipment window can fall outside.
    expect(Date.parse(sent.model.globalStartTime)).toBeLessThanOrEqual(
      Date.parse(AM.start),
    );
    expect(Date.parse(sent.model.globalEndTime)).toBeGreaterThanOrEqual(
      Date.parse(PM.end),
    );
  });

  it("leaves room either side for the drive out and the drive back", async () => {
    const optimizer = new GoogleRouteOptimizer({ projectId: "p" });
    await optimizer.optimize({ stops: [stop("a", PM), stop("b", PM)] } as never);

    // The vehicle leaves the pharmacy before the first window opens and
    // returns after the last one closes; both legs sit inside the global
    // window, so it cannot hug the promises exactly.
    expect(Date.parse(sent.model.globalStartTime)).toBeLessThan(
      Date.parse(PM.start),
    );
    expect(Date.parse(sent.model.globalEndTime)).toBeGreaterThan(
      Date.parse(PM.end),
    );
  });

  it("sets no global window when nothing was promised", async () => {
    const optimizer = new GoogleRouteOptimizer({ projectId: "p" });
    await optimizer.optimize({ stops: [stop("a"), stop("b")] } as never);

    expect(sent.model.globalStartTime).toBeUndefined();
    expect(sent.model.globalEndTime).toBeUndefined();
  });

  it("ignores a stop with no coordinate when spanning the promises", async () => {
    // Deliberately far from the PM window, and further than the padding, so a
    // window that had wrongly counted it is distinguishable from one that
    // merely padded around the stops that were actually sent.
    const dawn = {
      start: "2026-09-09T06:00:00.000Z",
      end: "2026-09-09T09:00:00.000Z",
    };

    const optimizer = new GoogleRouteOptimizer({ projectId: "p" });
    await optimizer.optimize({
      stops: [
        stop("a", PM),
        stop("b", PM),
        // Never sent to the solver, so its promise must not widen the window.
        { orderId: "c", address: "hand-typed", isPriority: false, timeWindow: dawn },
      ],
    } as never);

    expect(Date.parse(sent.model.globalStartTime)).toBeGreaterThan(
      Date.parse(dawn.start),
    );
  });
});
