import { GoogleAuth } from "google-auth-library";

import { fetchJson } from "../http.js";
import type {
  EstimateResult,
  GeoPoint,
  OptimizeRequest,
  OptimizeResult,
  RouteOptimizer,
  RouteStop,
  StopEstimate,
} from "./types.js";

/**
 * Google Route Optimization adapter (`optimizeTours`).
 *
 * MODEL
 *
 * The API routes vehicles over shipments. Our shape is the simplest case it
 * supports: one vehicle (the driver), one shipment per stop, each with a
 * single delivery visit at the stop's coordinate. The vehicle starts at the
 * driver's live position when the app sent one, and at the pharmacy
 * otherwise, and always ends at the pharmacy — the driver has to bring
 * undelivered packages back before the return deadline, so a route that
 * strands them across town is not a route the pharmacy can use.
 *
 * WHY TIME WINDOWS ARE SOFT
 *
 * `timeWindows` on a visit request is a hard constraint: a solver that cannot
 * satisfy every window returns an infeasible solution and no ordering at all.
 * A pharmacy with three "between 2 and 3" promises across the island will hit
 * that regularly, and the correct answer for a driver holding those packages
 * is a good-enough route, not an error. So each shipment also carries a
 * `penaltyCost`, which makes it *skippable* in the solver's eyes — and any
 * shipment the solver then skips is appended by us afterwards rather than
 * actually dropped. The driver still gets every stop; the ones that could not
 * be fitted just lose their claim to a good position.
 *
 * WHY PRIORITY IS A COST, NOT AN ORDER
 *
 * `is_priority` outranks the optimizer entirely — the queue is sorted
 * `is_priority DESC` in SQL after this runs, which is a deliberate product
 * decision (an urgent stop goes first even if it costs kilometres). Priority
 * is still passed here, as a higher skip penalty, so that among the stops the
 * solver *can* place, an urgent one is never the one it gives up on.
 *
 * UNGEOCODED STOPS
 *
 * A stop with no coordinate cannot be sent at all. Those are held out of the
 * request and appended to the result in their incoming order, which is why
 * this adapter always returns exactly the stops it was given — the service's
 * count check would otherwise reject the whole run and degrade.
 */

const ENDPOINT = "https://routeoptimization.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Solver budget. The API bills by compute time and a driver is waiting, so
 * this is deliberately short — for a day's worth of stops the difference
 * between 10s and 60s of search is a few hundred metres.
 */
const SEARCH_TIMEOUT_SECONDS = 10;

/** HTTP budget. Must exceed the solver budget or we abort our own request. */
const HTTP_TIMEOUT_MS = 20_000;

/**
 * Cost of leaving a shipment out of the route, in the solver's arbitrary cost
 * units. Set far above any plausible travel cost so skipping is a last resort
 * rather than an optimization.
 */
const SKIP_PENALTY = 1_000_000;
const PRIORITY_SKIP_PENALTY = 10_000_000;

/** Minutes assumed at the door: park, walk up, hand over, get a signature. */
const VISIT_DURATION_SECONDS = 300;

/**
 * How far the model's global window is opened either side of the promises.
 *
 * The solver rejects any visit window that falls outside the model's global
 * window, and with no global window set it defaults to one that begins at the
 * Unix epoch — so a single real delivery promise fails the whole request with
 * `outside global time window`. The window is therefore derived from the
 * promises themselves, and padded, because the global window has to contain
 * more than the visits: the driver leaves the pharmacy before the first window
 * opens and gets back after the last one closes, and both legs live inside it.
 * Padding only creates room — the per-shipment windows still decide when a
 * patient is actually visited.
 */
const GLOBAL_WINDOW_PADDING_MS = 4 * 60 * 60 * 1000;

/**
 * The model-level window spanning every promise in the run.
 *
 * Returns nothing when no stop carries a promise: a run of plain stops solves
 * fine against the default window, and inventing a global window for it would
 * constrain a request that has no need of one.
 */
function globalWindow(stops: RouteStop[]): {
  globalStartTime?: string;
  globalEndTime?: string;
} {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;

  for (const stop of stops) {
    if (!stop.timeWindow) continue;
    const start = Date.parse(stop.timeWindow.start);
    const end = Date.parse(stop.timeWindow.end);
    if (Number.isFinite(start)) earliest = Math.min(earliest, start);
    if (Number.isFinite(end)) latest = Math.max(latest, end);
  }

  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return {};

  return {
    globalStartTime: new Date(earliest - GLOBAL_WINDOW_PADDING_MS).toISOString(),
    globalEndTime: new Date(latest + GLOBAL_WINDOW_PADDING_MS).toISOString(),
  };
}

interface OptimizeToursResponse {
  routes?: {
    visits?: {
      shipmentIndex?: number;
      startTime?: string;
    }[];
    transitions?: {
      travelDistanceMeters?: number;
      travelDuration?: string;
    }[];
  }[];
  skippedShipments?: { index?: number; label?: string }[];
}

/**
 * Route Optimization takes a bare `google.type.LatLng` for `arrivalLocation`,
 * `startLocation` and `endLocation`. There is no `latLng` wrapper here — that
 * belongs to a Waypoint, which is what the Routes API adapter next door builds
 * for a different endpoint. Sending the wrapped shape is rejected with a 400
 * `Unknown name "latLng" ... Cannot find field`, which the service turns into
 * a degraded route, so the mix-up looks like a provider outage rather than a
 * malformed request.
 */
function point(location: GeoPoint) {
  return { latitude: location.latitude, longitude: location.longitude };
}

/** Protobuf durations arrive as "123.45s". */
function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number.parseFloat(value.replace(/s$/, ""));
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

export interface GoogleOptimizerConfig {
  projectId: string;
  /**
   * Service account JSON, as a string. Optional — and preferably absent.
   *
   * When omitted the client falls back to Application Default Credentials,
   * which is both the more secure arrangement and the only one available to
   * many projects: `constraints/iam.disableServiceAccountKeyCreation` is on by
   * default for newer Google Cloud organizations, and lifting it needs
   * Organization Policy Administrator, which Owner does not include.
   *
   * ADC resolves, in order, to: an attached service account when the server
   * runs on GCP (nothing to configure, nothing to leak), a workload-identity
   * federation config when it runs elsewhere, or a developer's own
   * `gcloud auth application-default login` locally.
   */
  credentialsJson?: string;
}

export class GoogleRouteOptimizer implements RouteOptimizer {
  readonly name = "google";

  private readonly auth: GoogleAuth;

  constructor(private readonly config: GoogleOptimizerConfig) {
    this.auth = new GoogleAuth({
      // Passing no credentials is not a fallback to anonymous — GoogleAuth
      // then runs the ADC chain, and fails loudly at the first call if that
      // chain finds nothing.
      ...(config.credentialsJson
        ? { credentials: JSON.parse(config.credentialsJson) as Record<string, unknown> }
        : {}),
      projectId: config.projectId,
      scopes: [SCOPE],
    });
  }

  /**
   * Splits the stops the solver can place from the ones it cannot, and builds
   * the request body. Shared by optimize() and estimate() so the two can
   * never disagree about what was sent.
   */
  private plan(request: OptimizeRequest) {
    const routable: RouteStop[] = [];
    const unroutable: RouteStop[] = [];

    for (const stop of request.stops) {
      (stop.location ? routable : unroutable).push(stop);
    }

    const start = request.origin ?? request.depot;

    const body = {
      model: {
        ...globalWindow(routable),
        shipments: routable.map((stop) => ({
          // The order id rides along as a label so a skipped shipment can be
          // identified without relying on index arithmetic.
          label: stop.orderId,
          penaltyCost: stop.isPriority ? PRIORITY_SKIP_PENALTY : SKIP_PENALTY,
          deliveries: [
            {
              arrivalLocation: point(stop.location!),
              duration: `${VISIT_DURATION_SECONDS}s`,
              ...(stop.timeWindow
                ? {
                    timeWindows: [
                      {
                        startTime: stop.timeWindow.start,
                        endTime: stop.timeWindow.end,
                      },
                    ],
                  }
                : {}),
            },
          ],
        })),
        vehicles: [
          {
            label: "driver",
            ...(start ? { startLocation: point(start) } : {}),
            ...(request.depot ? { endLocation: point(request.depot) } : {}),
          },
        ],
      },
      searchMode: "RETURN_FAST" as const,
      timeout: `${SEARCH_TIMEOUT_SECONDS}s`,
    };

    return { routable, unroutable, body };
  }

  private async call(
    body: unknown,
  ): Promise<OptimizeToursResponse> {
    const token = await this.auth.getAccessToken();
    if (!token) throw new Error("google auth returned no access token");

    return fetchJson<OptimizeToursResponse>(
      `${ENDPOINT}/projects/${encodeURIComponent(this.config.projectId)}:optimizeTours`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body,
        timeoutMs: HTTP_TIMEOUT_MS,
      },
    );
  }

  /**
   * Reads the visit order out of a solved route.
   *
   * Returns the routable stops in solved order, followed by anything the
   * solver skipped, followed by anything that had no coordinate to send. The
   * result always contains every stop that came in, exactly once.
   */
  private sequence(
    response: OptimizeToursResponse,
    routable: RouteStop[],
    unroutable: RouteStop[],
  ): string[] {
    const visits = response.routes?.[0]?.visits ?? [];

    const seen = new Set<number>();
    const ordered: string[] = [];

    for (const visit of visits) {
      const index = visit.shipmentIndex ?? 0;
      const stop = routable[index];
      if (!stop || seen.has(index)) continue;
      seen.add(index);
      ordered.push(stop.orderId);
    }

    // Skipped or otherwise unvisited, then never-sent. Both keep their
    // incoming relative order, which is the driver's previous sequence.
    for (const [index, stop] of routable.entries()) {
      if (!seen.has(index)) ordered.push(stop.orderId);
    }
    for (const stop of unroutable) ordered.push(stop.orderId);

    return ordered;
  }

  async optimize(request: OptimizeRequest): Promise<OptimizeResult> {
    const { routable, unroutable, body } = this.plan(request);

    // Nothing to solve. Calling the API to reorder zero or one stop would
    // spend money and a second of a driver's time to learn nothing.
    if (routable.length < 2) {
      return {
        orderedOrderIds: [...routable, ...unroutable].map((s) => s.orderId),
        degraded: false,
        provider: this.name,
      };
    }

    const response = await this.call(body);

    return {
      orderedOrderIds: this.sequence(response, routable, unroutable),
      degraded: false,
      provider: this.name,
    };
  }

  /**
   * Per-stop travel from the previous point on the solved route.
   *
   * `transitions[i]` is the leg *into* `visits[i]`, so the two are read
   * together. Stops the solver skipped and stops that were never sent get
   * nulls — the contract is explicit that an adapter reports what it does not
   * know rather than guessing, because a driver makes real turns off these
   * numbers.
   */
  async estimate(request: OptimizeRequest): Promise<EstimateResult> {
    const { routable, unroutable, body } = this.plan(request);

    if (routable.length < 2) {
      return {
        estimates: request.stops.map((stop) => ({
          orderId: stop.orderId,
          distanceMeters: null,
          durationSeconds: null,
        })),
        degraded: routable.length === 0,
        provider: this.name,
      };
    }

    const response = await this.call(body);
    const route = response.routes?.[0];
    const visits = route?.visits ?? [];
    const transitions = route?.transitions ?? [];

    const measured = new Map<string, StopEstimate>();

    for (const [position, visit] of visits.entries()) {
      const stop = routable[visit.shipmentIndex ?? 0];
      if (!stop) continue;
      const leg = transitions[position];
      measured.set(stop.orderId, {
        orderId: stop.orderId,
        distanceMeters: leg?.travelDistanceMeters ?? null,
        durationSeconds: parseDuration(leg?.travelDuration),
      });
    }

    const blank = (stop: RouteStop): StopEstimate => ({
      orderId: stop.orderId,
      distanceMeters: null,
      durationSeconds: null,
    });

    return {
      estimates: [...routable, ...unroutable].map(
        (stop) => measured.get(stop.orderId) ?? blank(stop),
      ),
      degraded: false,
      provider: this.name,
    };
  }
}
