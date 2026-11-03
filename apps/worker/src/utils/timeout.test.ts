import { describe, expect, it } from "bun:test";
import { getOperationSignal } from "@midday/utils/operation-context";
import { TimeoutError, withTimeout } from "./timeout";

describe("abortable operation deadline", () => {
  it("aborts the transport before rejecting and cannot run a delayed callback", async () => {
    let committed = false,
      aborted = false;
    await expect(
      withTimeout(
        (signal) =>
          new Promise((resolve) => {
            expect(getOperationSignal()).toBe(signal);
            const timer = setTimeout(() => {
              committed = true;
              resolve("late");
            }, 100);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                aborted = true;
              },
              { once: true },
            );
          }),
        10,
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    await Bun.sleep(120);
    expect(aborted).toBe(true);
    expect(committed).toBe(false);
  });
  it("keeps nested IO under the shorter parent deadline", async () => {
    await expect(
      withTimeout(
        () =>
          withTimeout(
            (signal) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              }),
            500,
          ),
        10,
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
  it("reports a definite successful result without leaving an abort timer", async () => {
    let signal: AbortSignal | undefined;
    expect(
      await withTimeout(async (s) => {
        signal = s;
        return 42;
      }, 10),
    ).toBe(42);
    await Bun.sleep(20);
    expect(signal?.aborted).toBe(false);
  });
});
