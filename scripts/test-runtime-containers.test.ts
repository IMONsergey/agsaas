import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  createDockerRunner,
  createRuntimeInterruption,
} from "./test-runtime-containers";

describe("isolated runtime harness cancellation (no Docker)", () => {
  test.each([
    "SIGINT",
    "SIGTERM",
  ] as const)("%s aborts operations and keeps repeated-signal handlers installed", (signal) => {
    const emitter = new EventEmitter();
    const interruption = createRuntimeInterruption(emitter);
    let aborts = 0;
    interruption.signal.addEventListener("abort", () => {
      aborts += 1;
    });
    expect(interruption.signal.aborted).toBe(false);
    emitter.emit(signal);
    emitter.emit(signal);
    emitter.emit("SIGTERM");
    expect(interruption.signal.aborted).toBe(true);
    expect(aborts).toBe(1);
    expect(emitter.listenerCount("SIGINT")).toBe(1);
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    interruption.dispose();
    interruption.dispose();
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
  test("an already-aborted operation does not start a new child", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = createDockerRunner(controller.signal, process.execPath);
    await expect(
      run(["--no-env-file", "--eval", "console.log('unexpected-start');"], {
        timeoutMs: 2000,
      }),
    ).rejects.toThrow();
  });
  test("cleanup completes after cancellation and a second signal", async () => {
    const emitter = new EventEmitter();
    const interruption = createRuntimeInterruption(emitter);
    const run = createDockerRunner(interruption.signal, process.execPath);
    emitter.emit("SIGINT");
    const cleanup = run(
      [
        "--no-env-file",
        "--eval",
        "await Bun.sleep(100); console.log('cleanup-complete');",
      ],
      { timeoutMs: 2000, cancellable: false },
    );
    emitter.emit("SIGTERM");
    try {
      await expect(cleanup).resolves.toBe("cleanup-complete");
    } finally {
      interruption.dispose();
    }
  });
  test("in-flight operations are killed on cancellation", async () => {
    const controller = new AbortController();
    const run = createDockerRunner(controller.signal, process.execPath);
    const startedAt = performance.now();
    const operation = run(
      ["--no-env-file", "--eval", "await Bun.sleep(10000);"],
      { timeoutMs: 10_000 },
    );
    controller.abort();
    await expect(operation).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
  test("cleanup still has its own hard deadline", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = createDockerRunner(controller.signal, process.execPath);
    await expect(
      run(["--no-env-file", "--eval", "await Bun.sleep(10000);"], {
        timeoutMs: 50,
        cancellable: false,
      }),
    ).rejects.toThrow();
  });
});
