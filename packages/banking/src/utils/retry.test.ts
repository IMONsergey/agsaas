import { describe, expect, it } from "bun:test";
import { getRateLimitDelay, withRateLimitRetry, withRetry } from "./retry";

describe("withRetry", () => {
  it("retries a failed operation and passes the attempt number", async () => {
    const attempts: number[] = [];
    const result = await withRetry(
      (attempt) => {
        attempts.push(attempt);
        if (attempt < 2) {
          throw new Error("temporary failure");
        }
        return "ok";
      },
      { maxRetries: 2 },
    );

    expect(result).toBe("ok");
    expect(attempts).toEqual([0, 1, 2]);
  });

  it("stops immediately when the error handler rejects a retry", async () => {
    const attempts: number[] = [];
    const failure = new Error("permanent failure");

    await expect(
      withRetry(
        (attempt) => {
          attempts.push(attempt);
          throw failure;
        },
        { maxRetries: 3, onError: () => false },
      ),
    ).rejects.toBe(failure);

    expect(attempts).toEqual([0]);
  });
});

describe("getRateLimitDelay", () => {
  it("reads GoCardless's reset header before Retry-After", () => {
    const error = {
      response: {
        headers: {
          HTTP_X_RATELIMIT_ACCOUNT_SUCCESS_RESET: "4",
          "retry-after": "2",
        },
      },
    };

    expect(getRateLimitDelay(error, 0)).toBe(4000);
  });

  it("reads numeric Retry-After from a Headers instance", () => {
    const headers = new Headers({ "Retry-After": "1.5" });
    expect(getRateLimitDelay({ headers }, 0)).toBe(1500);
  });

  it("supports the HTTP-date form of Retry-After", () => {
    const retryAt = new Date(Date.now() + 60_000).toUTCString();
    const delay = getRateLimitDelay(
      { response: { headers: { "Retry-After": retryAt } } },
      0,
    );

    expect(delay).toBeGreaterThanOrEqual(58_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it("supports a Unix timestamp in X-RateLimit-Reset", () => {
    const resetAtSeconds = Math.floor(Date.now() / 1000) + 30;
    const delay = getRateLimitDelay(
      { headers: { "x-ratelimit-reset": String(resetAtSeconds) } },
      0,
    );

    expect(delay).toBeGreaterThanOrEqual(28_000);
    expect(delay).toBeLessThanOrEqual(30_000);
  });

  it("ignores malformed headers and falls back to jittered backoff", () => {
    const delay = getRateLimitDelay(
      { headers: { "retry-after": "-1", "x-ratelimit-reset": "invalid" } },
      1,
    );

    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThan(3000);
  });
});

describe("withRateLimitRetry", () => {
  it("retries HTTP 429 and resolves without changing the result", async () => {
    let calls = 0;
    const result = await withRateLimitRetry(
      () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, headers: { "retry-after": "0" } } };
        }
        return { connected: true };
      },
      { maxRetries: 1 },
    );

    expect(result).toEqual({ connected: true });
    expect(calls).toBe(2);
  });

  it("recognizes Plaid's rate-limit error type", async () => {
    let calls = 0;
    await withRateLimitRetry(
      () => {
        calls++;
        if (calls === 1) {
          throw {
            response: {
              data: { error_type: "RATE_LIMIT_EXCEEDED" },
              headers: { "retry-after": "0" },
            },
          };
        }
        return undefined;
      },
      { maxRetries: 1 },
    );

    expect(calls).toBe(2);
  });

  it("never retries unrelated failures", async () => {
    const failure = { status: 400, message: "bad request" };
    let calls = 0;

    await expect(
      withRateLimitRetry(() => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(calls).toBe(1);
  });
});
