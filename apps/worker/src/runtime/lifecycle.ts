export type WorkerPhase = "starting" | "ready" | "draining" | "stopped";

export type LifecycleResource = {
  name: string;
  close(): unknown | Promise<unknown>;
};

export type ShutdownResult = {
  exitCode: 0 | 1;
  timedOut: boolean;
  failedResources: string[];
};

type LifecycleOptions = {
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** HTTP admission and workers drain before their dependencies are closed. */
  drainResources(): readonly LifecycleResource[];
  closeResources(): readonly LifecycleResource[];
  finalResources?(): readonly LifecycleResource[];
  onError?(resource: string, error: unknown): void;
  onReady?(): void;
  onExit?(result: ShutdownResult): void;
};

/** No connections or process listeners: the entry point supplies owned resources. */
export function createWorkerLifecycle(options: LifecycleOptions) {
  let phase: WorkerPhase = "starting";
  let startup: Promise<boolean> | undefined;
  let shutdownPromise: Promise<ShutdownResult> | undefined;
  let requestedExitCode: 0 | 1 = 0;
  const startupController = new AbortController();
  const failedResources = new Set<string>();
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;

  // Signals and shutdown callbacks may change this state across any await.
  const getPhase = (): WorkerPhase => phase;

  if (
    !Number.isFinite(startupTimeoutMs) ||
    startupTimeoutMs <= 0 ||
    !Number.isFinite(shutdownTimeoutMs) ||
    shutdownTimeoutMs <= 0
  ) {
    throw new Error(
      "Worker lifecycle deadlines must be positive finite numbers",
    );
  }

  function reportFailure(resource: string, error: unknown) {
    if (phase === "stopped") return;
    requestedExitCode = 1;
    failedResources.add(resource);
    try {
      options.onError?.(resource, error);
    } catch {
      // A failing logger/reporter must never prevent resource cleanup or exit.
    }
  }

  function shutdown(
    reason: string,
    exitCode: 0 | 1 = 0,
  ): Promise<ShutdownResult> {
    if (exitCode === 1 && phase !== "stopped") requestedExitCode = 1;
    if (shutdownPromise) return shutdownPromise;

    // Admission closes synchronously, before any cleanup await or signal race.
    phase = "draining";
    startupController.abort();

    shutdownPromise = Promise.resolve().then(async () => {
      let expired = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      async function closeStage(
        name: string,
        resources: () => readonly LifecycleResource[],
      ) {
        if (expired) return;
        let snapshot: readonly LifecycleResource[];
        try {
          snapshot = resources();
        } catch (error) {
          reportFailure(name, error);
          return;
        }
        await Promise.all(
          snapshot.map(async (resource) => {
            try {
              await resource.close();
            } catch (error) {
              reportFailure(resource.name, error);
            }
          }),
        );
      }

      const deadline = new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => {
          expired = true;
          reportFailure(
            "shutdown",
            new Error(`Shutdown deadline exceeded (${reason})`),
          );
          resolve("timeout");
        }, shutdownTimeoutMs);
      });

      const cleanup = (async () => {
        await closeStage("drain", options.drainResources);
        await closeStage("dependencies", options.closeResources);
        await closeStage("telemetry", options.finalResources ?? (() => []));
        return "complete" as const;
      })();

      const outcome = await Promise.race([cleanup, deadline]);
      clearTimeout(timeout);
      phase = "stopped";
      const result: ShutdownResult = {
        exitCode: requestedExitCode,
        timedOut: outcome === "timeout",
        failedResources: [...failedResources],
      };
      options.onExit?.(result);
      return result;
    });

    return shutdownPromise;
  }

  function start(
    initialize: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    if (startup) return startup;
    if (phase !== "starting") return Promise.resolve(false);

    startup = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Worker startup stopped"));
        startupController.signal.addEventListener("abort", onAbort, {
          once: true,
        });
      });
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Worker startup deadline exceeded")),
          startupTimeoutMs,
        );
      });

      try {
        await Promise.race([
          Promise.resolve().then(() => {
            if (startupController.signal.aborted) {
              throw new Error("Worker startup stopped");
            }
            return initialize(startupController.signal);
          }),
          deadline,
          stopped,
        ]);
        if (getPhase() !== "starting") return false;
        phase = "ready";
        options.onReady?.();
        return true;
      } catch (error) {
        const currentPhase = getPhase();
        if (currentPhase === "draining" || currentPhase === "stopped")
          return false;
        reportFailure("startup", error);
        await shutdown("startup failure", 1);
        return false;
      } finally {
        clearTimeout(timeout);
        if (onAbort)
          startupController.signal.removeEventListener("abort", onAbort);
      }
    })();

    return startup;
  }

  return { start, shutdown, getPhase };
}

export type WorkerLifecycle = ReturnType<typeof createWorkerLifecycle>;
