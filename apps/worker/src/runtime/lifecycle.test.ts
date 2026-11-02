import { describe, expect, mock, test } from "bun:test";
import { createWorkerLifecycle, type LifecycleResource } from "./lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("worker lifecycle", () => {
  test("readiness waits for worker connections and scheduler registration", async () => {
    const worker = deferred();
    const schedulers = deferred();
    const onReady = mock(() => {});
    const lifecycle = createWorkerLifecycle({
      drainResources: () => [],
      closeResources: () => [],
      onReady,
    });
    const started = lifecycle.start(async () => {
      await worker.promise;
      await schedulers.promise;
    });
    expect(lifecycle.getPhase()).toBe("starting");
    worker.resolve();
    await Promise.resolve();
    expect(lifecycle.getPhase()).toBe("starting");
    schedulers.resolve();
    expect(await started).toBe(true);
    expect(lifecycle.getPhase()).toBe("ready");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(await lifecycle.shutdown("test")).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
  });

  test("two signals share cleanup and keep dependencies alive until drain finishes", async () => {
    const drain = deferred();
    const events: string[] = [];
    const onExit = mock(() => {});
    const lifecycle = createWorkerLifecycle({
      drainResources: () => [
        {
          name: "worker",
          close: async () => {
            events.push("worker");
            await drain.promise;
          },
        },
      ],
      closeResources: () => [
        {
          name: "database",
          close: () => {
            events.push("database");
          },
        },
      ],
      finalResources: () => [
        {
          name: "sentry",
          close: () => {
            events.push("sentry");
          },
        },
      ],
      onExit,
    });
    await lifecycle.start(async () => {});
    const first = lifecycle.shutdown("SIGTERM");
    expect(lifecycle.getPhase()).toBe("draining");
    expect(lifecycle.shutdown("SIGINT")).toBe(first);
    await Promise.resolve();
    expect(events).toEqual(["worker"]);
    drain.resolve();
    expect(await first).toMatchObject({ exitCode: 0, timedOut: false });
    expect(events).toEqual(["worker", "database", "sentry"]);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(lifecycle.shutdown("SIGTERM")).toBe(first);
  });

  test("partial initialization closes only resources created so far", async () => {
    const owned: LifecycleResource[] = [];
    const closed: string[] = [];
    const onExit = mock(() => {});
    const lifecycle = createWorkerLifecycle({
      drainResources: () => owned,
      closeResources: () => [
        {
          name: "database",
          close: () => {
            closed.push("database");
          },
        },
      ],
      onExit,
    });
    expect(
      await lifecycle.start(async () => {
        owned.push({
          name: "worker:first",
          close: () => {
            closed.push("worker:first");
          },
        });
        throw new Error("second worker constructor failed");
      }),
    ).toBe(false);
    expect(closed).toEqual(["worker:first", "database"]);
    expect(onExit).toHaveBeenCalledWith({
      exitCode: 1,
      timedOut: false,
      failedResources: ["startup"],
    });
  });

  test("cleanup rejections do not skip other resources or telemetry", async () => {
    const closed: string[] = [];
    const lifecycle = createWorkerLifecycle({
      drainResources: () => [
        {
          name: "broken worker",
          close: () => {
            throw new Error("drain failed");
          },
        },
      ],
      closeResources: () => [
        {
          name: "broken queue",
          close: async () => {
            throw new Error("close failed");
          },
        },
        {
          name: "database",
          close: () => {
            closed.push("database");
          },
        },
      ],
      finalResources: () => [
        {
          name: "sentry",
          close: () => {
            closed.push("sentry");
          },
        },
      ],
      onError: () => {
        throw new Error("reporter failed too");
      },
    });
    const result = await lifecycle.shutdown("test");
    expect(result).toEqual({
      exitCode: 1,
      timedOut: false,
      failedResources: ["broken worker", "broken queue"],
    });
    expect(closed).toEqual(["database", "sentry"]);
  });

  test("a single total deadline bounds stuck cleanup and prevents late stages", async () => {
    const drain = deferred();
    const databaseClose = mock(async () => {});
    const onExit = mock(() => {});
    const lifecycle = createWorkerLifecycle({
      shutdownTimeoutMs: 30,
      drainResources: () => [
        { name: "stuck worker", close: () => drain.promise },
      ],
      closeResources: () => [{ name: "database", close: databaseClose }],
      onExit,
    });
    const startedAt = Date.now();
    expect(await lifecycle.shutdown("SIGTERM")).toEqual({
      exitCode: 1,
      timedOut: true,
      failedResources: ["shutdown"],
    });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(databaseClose).not.toHaveBeenCalled();
    drain.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(databaseClose).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test("a fatal error during an existing drain upgrades the exit code", async () => {
    const drain = deferred();
    const close = mock(() => drain.promise);
    const lifecycle = createWorkerLifecycle({
      drainResources: () => [{ name: "worker", close }],
      closeResources: () => [],
    });
    const stopping = lifecycle.shutdown("SIGTERM");
    expect(lifecycle.shutdown("uncaughtException", 1)).toBe(stopping);
    drain.resolve();
    expect((await stopping).exitCode).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("late startup cannot become ready after shutdown", async () => {
    const initialized = deferred();
    const entered = deferred();
    const onReady = mock(() => {});
    const lifecycle = createWorkerLifecycle({
      drainResources: () => [],
      closeResources: () => [],
      onReady,
    });
    const started = lifecycle.start(async () => {
      entered.resolve();
      await initialized.promise;
    });
    await entered.promise;
    await lifecycle.shutdown("SIGTERM");
    initialized.resolve();
    expect(await started).toBe(false);
    expect(lifecycle.getPhase()).toBe("stopped");
    expect(onReady).not.toHaveBeenCalled();
  });

  test("a signal before initialization prevents resource creation", async () => {
    const initialize = mock(async () => {});
    const lifecycle = createWorkerLifecycle({
      drainResources: () => [],
      closeResources: () => [],
    });
    const started = lifecycle.start(initialize);
    await lifecycle.shutdown("SIGTERM");
    expect(await started).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
  });

  test("startup timeout enters the same nonzero cleanup path", async () => {
    const close = mock(async () => {});
    const onExit = mock(() => {});
    const lifecycle = createWorkerLifecycle({
      startupTimeoutMs: 20,
      drainResources: () => [],
      closeResources: () => [{ name: "database", close }],
      onExit,
    });
    expect(await lifecycle.start(() => new Promise(() => {}))).toBe(false);
    expect(lifecycle.getPhase()).toBe("stopped");
    expect(close).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith({
      exitCode: 1,
      timedOut: false,
      failedResources: ["startup"],
    });
  });

  test("resource discovery failure still runs later cleanup stages", async () => {
    const close = mock(async () => {});
    const lifecycle = createWorkerLifecycle({
      drainResources: () => {
        throw new Error("partial init lookup failed");
      },
      closeResources: () => [{ name: "database", close }],
    });
    expect((await lifecycle.shutdown("test")).exitCode).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects an invalid deadline %s", (timeout) => {
    expect(() =>
      createWorkerLifecycle({
        shutdownTimeoutMs: timeout,
        drainResources: () => [],
        closeResources: () => [],
      }),
    ).toThrow("deadlines");
  });
});
