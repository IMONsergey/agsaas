import { describe, expect, test } from "bun:test";
import { withRateLimitRetry, withRetry } from "./retry";

describe("banking transport cancellation", () => {
  test("pre-aborted operation cannot start HTTP", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls++;
          return "unexpected";
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test("aborting Retry-After sleep prevents a later request", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = withRateLimitRetry(
      async () => {
        calls++;
        throw { status: 429, headers: { "retry-after": "20" } };
      },
      { signal: controller.signal },
    );
    const timer = setTimeout(() => controller.abort(), 5);
    try {
      await expect(pending).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(calls).toBe(1);
  });
  test("unbounded provider backoff returns to the durable scheduler", async () => {
    let calls = 0;
    const error = { status: 429, headers: { "retry-after": "86400" } };
    await expect(
      withRateLimitRetry(async () => {
        calls++;
        throw error;
      }),
    ).rejects.toEqual(error);
    expect(calls).toBe(1);
  });
  test("ordinary retry sleep also observes cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = withRetry(
      async () => {
        calls++;
        controller.abort();
        throw new Error("fixture");
      },
      { delay: 100, signal: controller.signal },
    );
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test("a definite zero-delay rate limit may retry successfully", async () => {
    let calls = 0;
    const result = await withRateLimitRetry(async () => {
      if (++calls === 1) throw { status: 429, headers: { "retry-after": "0" } };
      return "accepted read";
    });
    expect(result).toBe("accepted read");
    expect(calls).toBe(2);
  });
});
