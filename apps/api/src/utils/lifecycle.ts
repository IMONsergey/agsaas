type CleanupStep = {
  name: string;
  close: () => unknown | Promise<unknown>;
};

type LifecycleLogger = {
  info: (message: string) => unknown;
  warn: (message: string) => unknown;
  error: (message: string, context: Record<string, unknown>) => unknown;
};

export type ShutdownResult = {
  exitCode: 0 | 1;
  timedOut: boolean;
  failedSteps: string[];
};

/** Owns one HTTP drain and one cleanup pass, even when signals overlap. */
export function createApiLifecycle(options: {
  stopHttp: (force: boolean) => void | Promise<void>;
  cleanup: CleanupStep[];
  logger: LifecycleLogger;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 12_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Shutdown timeout must be a positive finite number");
  }

  let shuttingDown = false;
  let requestedExitCode: 0 | 1 = 0;
  let shutdownPromise: Promise<ShutdownResult> | undefined;
  let finalResult: ShutdownResult | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let forceStopPromise: Promise<void> | undefined;
  const failedSteps: string[] = [];

  function log(
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) {
    try {
      if (level === "error") options.logger.error(message, context ?? {});
      else options.logger[level](message);
    } catch {
      // Reporting failures must never interrupt shutdown or create a rejected,
      // unobserved cleanup promise. Do not recursively log a logger failure.
      const step = `logger.${level}`;
      if (!failedSteps.includes(step)) failedSteps.push(step);
    }
  }

  function recordFailure(step: string, error: unknown) {
    failedSteps.push(step);
    log("error", "API shutdown step failed", {
      step,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  function forceStop() {
    forceStopPromise ??= Promise.resolve()
      .then(() => options.stopHttp(true))
      .catch((error: unknown) => recordFailure("force HTTP stop", error));
    return forceStopPromise;
  }

  function closeResources() {
    // Start each cleanup independently. A rejected or stuck DB close must not
    // prevent the queue, bot, cache, or telemetry clients from being closed.
    cleanupPromise ??= Promise.all(
      options.cleanup.map(({ name, close }) =>
        Promise.resolve()
          .then(close)
          .catch((error: unknown) => recordFailure(name, error)),
      ),
    ).then(() => undefined);
    return cleanupPromise;
  }

  async function drainAndClose() {
    try {
      await options.stopHttp(false);
    } catch (error) {
      recordFailure("HTTP drain", error);
      await forceStop();
    }
    await closeResources();
  }

  function shutdown(
    signal: string,
    exitCode: 0 | 1 = 0,
  ): Promise<ShutdownResult> {
    if (exitCode === 1) {
      requestedExitCode = 1;
      if (finalResult) finalResult.exitCode = 1;
    }
    if (shutdownPromise) return shutdownPromise;

    // Flip readiness synchronously, before yielding or stopping the listener.
    shuttingDown = true;
    log("info", `Received ${signal}, starting graceful shutdown...`);

    shutdownPromise = (async (): Promise<ShutdownResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        });
        const timedOut = await Promise.race([
          drainAndClose().then(() => false as const),
          deadline,
        ]);

        if (timedOut) {
          log("warn", "Shutdown timeout reached, forcing exit");
          // Terminate remaining requests before attempting the one cleanup
          // pass. Do not let a hung close extend the process deadline.
          void forceStop();
          void closeResources();
        }

        if (!timedOut && !requestedExitCode && failedSteps.length === 0) {
          log("info", "Graceful shutdown complete");
        }
        finalResult = {
          exitCode:
            timedOut || requestedExitCode || failedSteps.length > 0 ? 1 : 0,
          timedOut,
          failedSteps: [...failedSteps],
        };
        return finalResult;
      } finally {
        clearTimeout(timer);
      }
    })();

    return shutdownPromise;
  }

  return {
    isShuttingDown: () => shuttingDown,
    shutdown,
  };
}
