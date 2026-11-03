import { setTimeout as delayWithSignal } from "node:timers/promises";

async function waitForRetry(delay: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await delayWithSignal(delay, undefined, { signal });
}

export async function withRetry<TResult>(
  fn: (attempt: number) => TResult | Promise<TResult>,
  {
    maxRetries = 1,
    onError,
    delay,
    signal,
  }: {
    maxRetries?: number;
    onError?(error: unknown, attempt: number): boolean | undefined;
    delay?: number;
    signal?: AbortSignal;
  } = {},
) {
  let retries = 0;
  let lastError: unknown;

  while (retries <= maxRetries) {
    signal?.throwIfAborted();
    if (delay && retries > 0) {
      await waitForRetry(delay, signal);
    }

    try {
      const res = await fn(retries);
      return res;
    } catch (err) {
      lastError = err;

      if (onError) {
        const shouldRetry = onError(err, retries);
        if (!shouldRetry) {
          break;
        }
      }

      retries++;
    }
  }

  throw lastError;
}

/**
 * Extract the delay (in ms) to wait before retrying a rate-limited request.
 *
 * Checks for:
 * - Retry-After header (seconds or HTTP-date)
 * - X-RateLimit-Reset / HTTP_X_RATELIMIT_ACCOUNT_SUCCESS_RESET (seconds until reset)
 *
 * Falls back to exponential backoff with jitter if no header is found.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readHeader(headers: unknown, name: string): unknown {
  const record = asRecord(headers);
  if (!record) {
    return null;
  }

  // Fetch Headers and AxiosHeaders expose a case-insensitive get() method.
  if (typeof record.get === "function") {
    const value = record.get(name);
    if (value != null) {
      return value;
    }
  }

  // Plain objects from xior/axios can have arbitrary header casing.
  const entry = Object.entries(record).find(
    ([key]) => key.toLowerCase() === name,
  );
  return entry?.[1] ?? null;
}

function parseNonNegativeSeconds(value: unknown): number | null {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Extract retry delay from provider headers.
 * Retry-After accepts either seconds or an HTTP-date. Rate-limit reset
 * headers can hold seconds-until-reset or a Unix timestamp in seconds.
 */
export function getRateLimitDelay(error: unknown, attempt: number): number {
  const errorRecord = asRecord(error);
  const response = asRecord(errorRecord?.response);
  const headers = response?.headers ?? errorRecord?.headers;

  const goCardlessReset = parseNonNegativeSeconds(
    readHeader(headers, "http_x_ratelimit_account_success_reset") ??
      readHeader(headers, "x-ratelimit-account-success-reset"),
  );
  if (goCardlessReset !== null) {
    return goCardlessReset * 1000;
  }

  const retryAfter = readHeader(headers, "retry-after");
  const retrySeconds = parseNonNegativeSeconds(retryAfter);
  if (retrySeconds !== null) {
    return retrySeconds * 1000;
  }

  if (typeof retryAfter === "string" && Number.isNaN(Number(retryAfter))) {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }

  const reset = parseNonNegativeSeconds(
    readHeader(headers, "x-ratelimit-reset"),
  );
  if (reset !== null) {
    return reset >= 1_000_000_000
      ? Math.max(0, reset * 1000 - Date.now())
      : reset * 1000;
  }

  // Exponential backoff with jitter: 1s, 2s, 4s + random 0-1s.
  return Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 1000;
}

/**
 * Check if an error is an HTTP 429 (rate limited) response.
 */
function isRateLimitError(error: unknown): boolean {
  const errorRecord = asRecord(error);
  const response = asRecord(errorRecord?.response);
  const status =
    response?.status ?? errorRecord?.status ?? errorRecord?.statusCode;

  if (status === 429 || status === "429") {
    return true;
  }

  // Plaid can report rate limits in the response body without an HTTP 429.
  const responseData = asRecord(response?.data);
  return (
    (responseData?.error_type ?? errorRecord?.error_type) ===
    "RATE_LIMIT_EXCEEDED"
  );
}

/**
 * Wraps an async function with automatic rate limit retry handling.
 * On HTTP 429: reads provider headers for delay, falls back to exponential backoff.
 * Non-429 errors are thrown immediately.
 */
export async function withRateLimitRetry<TResult>(
  fn: () => TResult | Promise<TResult>,
  {
    maxRetries = 3,
    signal,
  }: { maxRetries?: number; signal?: AbortSignal } = {},
): Promise<TResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRateLimitError(err) || attempt === maxRetries) {
        throw err;
      }

      signal?.throwIfAborted();
      const delayMs = getRateLimitDelay(err, attempt);
      // Long provider backoff belongs in the durable scheduler, not a hanging
      // in-process timer. Do not retry earlier than Retry-After requested.
      if (!Number.isFinite(delayMs) || delayMs > 30_000) throw err;
      await waitForRetry(delayMs, signal);
    }
  }

  throw lastError;
}
