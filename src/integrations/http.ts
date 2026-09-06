/**
 * Outbound HTTP for third-party adapters.
 *
 * This is the only place the server calls anything it does not own, so the
 * rules that keep a slow vendor from becoming a slow API live here rather
 * than in each adapter.
 *
 * WHY A TIMEOUT IS MANDATORY
 *
 * Every caller is inside a request a human is waiting on: an employee mid-way
 * through typing an address, or a driver holding packages who tapped
 * "optimize". Node's fetch has no default timeout, so without this an
 * unreachable provider hangs until the socket gives up — minutes — and takes a
 * request worker with it. Both call sites degrade gracefully on failure, and
 * failing in two seconds is what makes that degradation useful.
 *
 * WHY NO RETRIES HERE
 *
 * A retry is a policy decision that depends on what the call costs. Places is
 * billed per session and re-billing a keystroke is waste; route optimization
 * is slow enough that a second attempt would blow the timeout budget anyway.
 * Adapters that genuinely want a retry can wrap this; none currently do.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface JsonRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** Defaults to 5s — long enough for a cold provider, short enough to degrade. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Response bodies are only ever read to build an error message. */
const MAX_ERROR_BODY = 500;

export async function fetchJson<T>(
  url: string,
  request: JsonRequest = {},
): Promise<T> {
  const { method = "GET", headers = {}, body, timeoutMs } = request;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      // Read the body: provider errors carry the actual reason (bad key,
      // quota, malformed field mask) and a bare status code turns a
      // five-minute fix into an afternoon.
      const text = (await response.text().catch(() => "")).slice(
        0,
        MAX_ERROR_BODY,
      );
      // The body carries the actual reason — a bad key, a quota, a malformed
      // field mask, a departure time in the past. Putting it in the message
      // rather than only on the object means every log line that prints the
      // error is diagnostic, without each caller remembering to unpack it.
      throw new HttpError(
        response.status,
        text,
        `${method} ${new URL(url).host} responded ${response.status}: ${text}`,
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    // AbortError is what a timeout looks like from inside; name it, because
    // "operation was aborted" in a log tells no one which provider was slow.
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `${method} ${new URL(url).host} timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
