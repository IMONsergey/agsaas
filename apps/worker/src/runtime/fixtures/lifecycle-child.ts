import { createWorkerLifecycle } from "../lifecycle";
import { installWorkerProcessHandlers } from "../process-handlers";

// This process owns only fake resources and real timers. Never import the worker
// entry point, providers, database clients, or queue factories in this fixture.
const scenario = process.argv[2] ?? "signals";
const emit = (event: string, extra: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, ...extra }));
};
const keepalive = setInterval(() => {}, 1000);
const lifecycle = createWorkerLifecycle({
  shutdownTimeoutMs: scenario === "timeout" ? 80 : 1500,
  drainResources: () => [
    {
      name: "timer",
      close: () => {
        clearInterval(keepalive);
        emit("close", { resource: "timer" });
      },
    },
    {
      name: "http",
      close: () => {
        emit("close", { resource: "http" });
      },
    },
    {
      name: "worker",
      close: async () => {
        emit("close", { resource: "worker" });
        if (scenario === "timeout") await new Promise(() => {});
        else await new Promise((resolve) => setTimeout(resolve, 150));
      },
    },
  ],
  closeResources: () => [
    {
      name: "queues",
      close: () => {
        emit("close", { resource: "queues" });
        if (scenario === "cleanup-error")
          throw new Error("fixture close failure");
      },
    },
    {
      name: "database",
      close: () => {
        emit("close", { resource: "database" });
      },
    },
    {
      name: "cache",
      close: () => {
        emit("close", { resource: "cache" });
      },
    },
  ],
  finalResources: () => [
    {
      name: "sentry",
      close: () => {
        emit("close", { resource: "sentry" });
      },
    },
  ],
  onError: (resource) => emit("error", { resource }),
  onExit: (result) => {
    emit("result", result);
    process.exit(result.exitCode);
  },
});

installWorkerProcessHandlers(lifecycle, (event) =>
  emit("fatal", { type: event }),
);
await lifecycle.start(async () => {});
emit("ready");

if (scenario === "exception") {
  setTimeout(() => {
    throw new Error("fixture uncaught exception");
  }, 20);
} else if (scenario === "rejection") {
  setTimeout(() => {
    void Promise.reject(new Error("fixture unhandled rejection"));
  }, 20);
}
