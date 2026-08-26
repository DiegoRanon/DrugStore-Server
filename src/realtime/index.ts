import type { RealtimeEvent, RealtimeOrderPayload } from "./events.js";

export * from "./events.js";

/**
 * The publish side of the realtime layer, as the domain sees it.
 *
 * Deliberately one method and no lifecycle: `NotificationsService` needs to say
 * "tell this driver something changed" without importing Fastify, Socket.IO, or
 * knowing whether a socket layer is even attached. Same shape and same reason as
 * `getRouteOptimizer()` in src/integrations/routing/index.ts.
 */
export interface Realtime {
  /**
   * Fire-and-forget by design — see `NullRealtime` below and the fail-open
   * comment in NotificationsService.emit.
   */
  toDriver(
    driverId: string,
    event: RealtimeEvent,
    payload: RealtimeOrderPayload,
  ): void;
}

/**
 * What runs when no socket layer is attached: REALTIME_ENABLED=false, unit
 * tests, and the window during boot before `attachRealtime` has run.
 *
 * Doing nothing is the correct behaviour, not a degraded one. A driver whose
 * event was never published finds the order on their next 30-second poll, which
 * is precisely the fallback PRD §7 requires of clients anyway.
 */
export class NullRealtime implements Realtime {
  toDriver(): void {}
}

let instance: Realtime = new NullRealtime();

export function getRealtime(): Realtime {
  return instance;
}

/** Called by `attachRealtime`, and by tests injecting a recorder. */
export function setRealtime(realtime: Realtime | null): void {
  instance = realtime ?? new NullRealtime();
}
