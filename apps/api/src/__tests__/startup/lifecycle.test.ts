import { describe, expect, mock, test } from "bun:test";
import { createApiLifecycle } from "../../utils/lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function logger() {
  return {
    info: mock((_message: string) => undefined),
    warn: mock((_message: string) => undefined),
    error: mock(
      (_message: string, _context: Record<string, unknown>) => undefined,
    ),
  };
}

describe("API shutdown lifecycle", () => {
  test.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("rejects invalid deadline %s before starting any cleanup", (timeoutMs) => {
    const stopHttp = mock(async (_force: boolean) => undefined);
    expect(() =>
      createApiLifecycle({
        stopHttp,
        cleanup: [],
        logger: logger(),
        timeoutMs,
      }),
    ).toThrow("positive finite number");
    expect(stopHttp).not.toHaveBeenCalled();
  });

  test("becomes unready immediately and deduplicates concurrent signals", async () => {
    const drain = deferred<void>();
    const stopHttp = mock((_force: boolean) => drain.promise);
    const close = mock(async () => undefined);
    const lifecycle = createApiLifecycle({
      stopHttp,
      cleanup: [{ name: "db", close }],
      logger: logger(),
    });

    expect(lifecycle.isShuttingDown()).toBe(false);
    const first = lifecycle.shutdown("SIGTERM");
    expect(lifecycle.isShuttingDown()).toBe(true);
    expect(lifecycle.shutdown("SIGINT")).toBe(first);
    expect(close).not.toHaveBeenCalled();
    expect(stopHttp).toHaveBeenCalledWith(false);

    drain.resolve();
    expect(await first).toEqual({
      exitCode: 0,
      timedOut: false,
      failedSteps: [],
    });
    expect(lifecycle.shutdown("SIGTERM")).toBe(first);
    expect(stopHttp).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("attempts every cleanup after both synchronous and async failures", async () => {
    const closed: string[] = [];
    const lifecycle = createApiLifecycle({
      stopHttp: async () => undefined,
      logger: logger(),
      cleanup: [
        {
          name: "db",
          close: () => {
            closed.push("db");
            throw new Error("DB close failed");
          },
        },
        {
          name: "redis",
          close: async () => {
            closed.push("redis");
            throw new Error("Redis close failed");
          },
        },
        {
          name: "queues",
          close: () => {
            closed.push("queues");
          },
        },
        {
          name: "telemetry",
          close: async () => {
            closed.push("telemetry");
          },
        },
      ],
    });

    const result = await lifecycle.shutdown("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.failedSteps.sort()).toEqual(["db", "redis"]);
    expect(closed).toEqual(["db", "redis", "queues", "telemetry"]);
  });

  test("force-stops after a rejected HTTP drain but still cleans resources", async () => {
    const stopHttp = mock(async (force: boolean) => {
      if (!force) throw new Error("HTTP drain failed");
    });
    const close = mock(async () => undefined);
    const lifecycle = createApiLifecycle({
      stopHttp,
      cleanup: [{ name: "db", close }],
      logger: logger(),
    });

    expect(await lifecycle.shutdown("SIGTERM")).toEqual({
      exitCode: 1,
      timedOut: false,
      failedSteps: ["HTTP drain"],
    });
    expect(stopHttp.mock.calls).toEqual([[false], [true]]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("bounds a stuck drain, force-stops, and starts cleanup only once", async () => {
    const drain = deferred<void>();
    const stopHttp = mock((force: boolean) =>
      force ? Promise.resolve() : drain.promise,
    );
    const close = mock(async () => undefined);
    const lifecycle = createApiLifecycle({
      stopHttp,
      cleanup: [{ name: "db", close }],
      logger: logger(),
      timeoutMs: 5,
    });

    const result = await lifecycle.shutdown("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(stopHttp.mock.calls).toEqual([[false], [true]]);
    expect(close).toHaveBeenCalledTimes(1);

    drain.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a stuck cleanup cannot block other cleanup or the deadline", async () => {
    const stuck = deferred<void>();
    const closeOther = mock(async () => undefined);
    const stopHttp = mock(async (_force: boolean) => undefined);
    const lifecycle = createApiLifecycle({
      stopHttp,
      logger: logger(),
      timeoutMs: 5,
      cleanup: [
        { name: "db", close: () => stuck.promise },
        { name: "queues", close: closeOther },
      ],
    });
    const result = await lifecycle.shutdown("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(closeOther).toHaveBeenCalledTimes(1);
    expect(stopHttp.mock.calls).toEqual([[false], [true]]);
    stuck.resolve();
  });

  test("clears the deadline when normal shutdown has completed", async () => {
    const log = logger();
    const lifecycle = createApiLifecycle({
      stopHttp: async () => undefined,
      cleanup: [],
      logger: log,
      timeoutMs: 5,
    });
    expect((await lifecycle.shutdown("SIGTERM")).exitCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("fatal errors request exit 1 even when cleanup succeeds", async () => {
    const lifecycle = createApiLifecycle({
      stopHttp: async () => undefined,
      cleanup: [],
      logger: logger(),
    });
    expect(await lifecycle.shutdown("uncaughtException", 1)).toEqual({
      exitCode: 1,
      timedOut: false,
      failedSteps: [],
    });
    expect(lifecycle.isShuttingDown()).toBe(true);
  });

  test("fatal errors escalate an existing signal drain and cannot be downgraded", async () => {
    const drain = deferred<void>();
    const stopHttp = mock(() => drain.promise);
    const close = mock(async () => undefined);
    const lifecycle = createApiLifecycle({
      stopHttp,
      cleanup: [{ name: "db", close }],
      logger: logger(),
    });
    const first = lifecycle.shutdown("SIGTERM");
    expect(lifecycle.shutdown("unhandledRejection", 1)).toBe(first);
    expect(lifecycle.shutdown("SIGINT", 0)).toBe(first);
    drain.resolve();
    expect((await first).exitCode).toBe(1);
    expect(stopHttp).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a late escalation still updates the single completed shutdown result", async () => {
    const lifecycle = createApiLifecycle({
      stopHttp: async () => undefined,
      cleanup: [],
      logger: logger(),
    });
    const first = lifecycle.shutdown("SIGTERM");
    expect((await first).exitCode).toBe(0);
    expect(lifecycle.shutdown("uncaughtException", 1)).toBe(first);
    expect((await first).exitCode).toBe(1);
  });

  test("an info logger failure does not break single-flight or cleanup", async () => {
    const log = logger();
    log.info.mockImplementation(() => {
      throw new Error("logger failed");
    });
    const close = mock(async () => undefined);
    const lifecycle = createApiLifecycle({
      stopHttp: async () => undefined,
      cleanup: [{ name: "db", close }],
      logger: log,
    });
    const first = lifecycle.shutdown("SIGTERM");
    expect(lifecycle.shutdown("SIGINT")).toBe(first);
    expect((await first).failedSteps).toContain("logger.info");
    expect((await first).exitCode).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("an error logger failure cannot mask cleanup failures or skip other clients", async () => {
    const log = logger();
    log.error.mockImplementation(() => {
      throw new Error("logger failed");
    });
    const closeOther = mock(async () => undefined);
    const lifecycle = createApiLifecycle({
      stopHttp: async () => undefined,
      logger: log,
      cleanup: [
        {
          name: "db",
          close: () => {
            throw new Error("DB close failed");
          },
        },
        { name: "redis", close: closeOther },
      ],
    });
    const result = await lifecycle.shutdown("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.failedSteps).toEqual(["db", "logger.error"]);
    expect(closeOther).toHaveBeenCalledTimes(1);
  });

  test("a warning logger failure cannot defeat the forced shutdown deadline", async () => {
    const drain = deferred<void>();
    const log = logger();
    log.warn.mockImplementation(() => {
      throw new Error("logger failed");
    });
    const stopHttp = mock((force: boolean) =>
      force ? Promise.resolve() : drain.promise,
    );
    const close = mock(async () => undefined);
    const lifecycle = createApiLifecycle({
      stopHttp,
      cleanup: [{ name: "db", close }],
      logger: log,
      timeoutMs: 5,
    });
    const result = await lifecycle.shutdown("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.failedSteps).toContain("logger.warn");
    expect(stopHttp.mock.calls).toEqual([[false], [true]]);
    expect(close).toHaveBeenCalledTimes(1);
    drain.resolve();
  });

  test("Bun HTTP drain lets an in-flight response finish before DB cleanup", async () => {
    const started = deferred<void>();
    const finishRequest = deferred<void>();
    const closeDb = mock(async () => undefined);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        started.resolve();
        await finishRequest.promise;
        expect(closeDb).not.toHaveBeenCalled();
        return new Response("request completed");
      },
    });
    const lifecycle = createApiLifecycle({
      stopHttp: (force) => server.stop(force),
      cleanup: [{ name: "db", close: closeDb }],
      logger: logger(),
    });

    try {
      const response = fetch(server.url);
      await started.promise;
      const shutdown = lifecycle.shutdown("SIGTERM");
      expect(closeDb).not.toHaveBeenCalled();
      finishRequest.resolve();
      expect(await (await response).text()).toBe("request completed");
      expect((await shutdown).exitCode).toBe(0);
      expect(closeDb).toHaveBeenCalledTimes(1);
    } finally {
      finishRequest.resolve();
      await server.stop(true);
    }
  });
});
