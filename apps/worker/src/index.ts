// Import Sentry instrumentation first, before any other modules
import "./instrument";

import { closeSharedRedisClient } from "@midday/cache/shared-redis";
import { checkWorkerHealth } from "@midday/db/utils/health";
import { closeWorkerDb, getWorkerPoolStats } from "@midday/db/worker-client";
import {
  buildReadinessResponse,
  checkDependencies,
} from "@midday/health/checker";
import { workerDependencies } from "@midday/health/probes";
import { closeQueues } from "@midday/job-client";
import { createLoggerWithContext } from "@midday/logger";
import * as Sentry from "@sentry/bun";
import { Worker } from "bullmq";
import { Hono } from "hono";
import { createWorkerAdminApp, getWorkerAdminAuth } from "./http/admin";
import { getProcessor } from "./processors/registry";
import { getAllQueues, queueConfigs } from "./queues";
import { createWorkerHealthApp } from "./runtime/health";
import { createWorkerLifecycle } from "./runtime/lifecycle";
import { installWorkerProcessHandlers } from "./runtime/process-handlers";
import { registerStaticSchedulers } from "./schedulers/registry";
import { extractErrorDetails } from "./utils/error-details";

const logger = createLoggerWithContext("worker");
const workers: Worker[] = [];
const queues = getAllQueues();
const redisClients: { status: string }[] = [];
let server: Pick<Bun.Server<unknown>, "stop"> | undefined;
let adminApp: ReturnType<typeof createWorkerAdminApp> | undefined;
let poolStatsInterval: ReturnType<typeof setInterval> | undefined;

const lifecycle = createWorkerLifecycle({
  drainResources: () => [
    {
      name: "db-pool-stats timer",
      close: () => {
        clearInterval(poolStatsInterval);
        poolStatsInterval = undefined;
      },
    },
    ...(server
      ? [{ name: "http server", close: () => server!.stop(false) }]
      : []),
    ...workers.map((worker) => ({
      name: `worker:${worker.name}`,
      close: () => worker.close(),
    })),
  ],
  closeResources: () => [
    { name: "workbench flow producer", close: () => adminApp?.close() },
    ...queues.map((queue) => ({
      name: `queue:${queue.name}`,
      close: () => queue.close(),
    })),
    { name: "job-client queues", close: closeQueues },
    { name: "redis cache", close: closeSharedRedisClient },
    { name: "worker database", close: closeWorkerDb },
  ],
  finalResources: () => [
    {
      name: "sentry",
      close: async () => {
        if (Sentry.getClient() && !(await Sentry.close(2000))) {
          throw new Error("Sentry flush did not complete");
        }
      },
    },
  ],
  onError: (resource, error) => {
    logger.error("Worker lifecycle failure", {
      resource,
      error: extractErrorDetails(error),
    });
    Sentry.captureException(error, {
      tags: { resource, errorType: "worker_lifecycle" },
    });
  },
  onReady: () =>
    logger.info("Workers initialized and ready to process jobs", {
      workers: workers.length,
    }),
  onExit: (result) => {
    try {
      logger.info("Worker shutdown finished", result);
    } finally {
      process.exit(result.exitCode);
    }
  },
});

installWorkerProcessHandlers(lifecycle, (event, error) => {
  logger.error("Fatal worker error", {
    event,
    error: extractErrorDetails(error),
  });
  Sentry.captureException(error, { tags: { errorType: event } });
});

/**
 * Create workers dynamically from queue configurations
 */
function createConfiguredWorker(config: (typeof queueConfigs)[number]): Worker {
  const worker = new Worker(
    config.name,
    async (job) => {
      const processor = getProcessor(job.name);
      if (!processor) {
        throw new Error(`No processor registered for job: ${job.name}`);
      }
      return processor.handle(job);
    },
    { ...config.workerOptions, autorun: false },
  );

  // Always attach error handler to prevent unhandled errors
  // See: https://docs.bullmq.io/guide/going-to-production#log-errors
  worker.on("error", (err) => {
    logger.error(`Worker error: ${config.name}`, {
      error: err.message,
      errorDetails: extractErrorDetails(err),
    });
    Sentry.captureException(err, {
      tags: { workerName: config.name, errorType: "worker_error" },
    });
  });

  // Centralized failed handler that captures to Sentry
  // Note: BaseProcessor already captures in-process failures with full context
  // This catches failures that bypass the processor (e.g., no processor registered)
  worker.on("failed", async (job, err) => {
    logger.error(`Job failed: ${job?.name}`, {
      worker: config.name,
      jobId: job?.id,
      error: err.message,
      errorDetails: extractErrorDetails(err),
    });
    Sentry.captureException(err, {
      tags: {
        workerName: config.name,
        jobName: job?.name ?? "unknown",
        errorType: "job_failed",
      },
      extra: {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
      },
    });

    // Call custom onFailed handler if provided
    // Pass full job info including data for status updates
    if (config.eventHandlers?.onFailed) {
      try {
        await config.eventHandlers.onFailed(
          job
            ? {
                name: job.name,
                id: job.id,
                data: job.data,
                attemptsMade: job.attemptsMade,
                opts: job.opts,
              }
            : null,
          err,
        );
      } catch (handlerError) {
        logger.error(`Error in onFailed handler: ${config.name}`, {
          error:
            handlerError instanceof Error
              ? handlerError.message
              : String(handlerError),
        });
        Sentry.captureException(handlerError, {
          tags: {
            workerName: config.name,
            errorType: "onfailed_handler_error",
          },
        });
      }
    }
  });

  // Register event handlers if provided
  if (config.eventHandlers) {
    if (config.eventHandlers.onCompleted) {
      worker.on("completed", (job) => {
        config.eventHandlers!.onCompleted!({
          name: job.name,
          id: job.id,
        });
      });
    }
  }

  return worker;
}

// Create Hono app
const app = new Hono();

app.use("*", async (c, next) => {
  if (
    (lifecycle.getPhase() === "draining" ||
      lifecycle.getPhase() === "stopped") &&
    c.req.path !== "/" &&
    c.req.path !== "/health" &&
    c.req.path !== "/health/ready"
  ) {
    return c.json({ error: "Worker is shutting down" }, 503);
  }
  return next();
});

app.route(
  "/",
  createWorkerHealthApp({
    getPhase: lifecycle.getPhase,
    isRuntimeReady: () =>
      workers.length === queueConfigs.length &&
      workers.every((worker) => worker.isRunning()) &&
      redisClients.length === workers.length * 2 + queues.length &&
      redisClients.every((client) => client.status === "ready"),
    checkReadiness: async () =>
      buildReadinessResponse(await checkDependencies(workerDependencies(), 1)),
  }),
);

// Initialize Workbench dashboard
function initializeWorkbench() {
  const auth = getWorkerAdminAuth({
    BOARD_USERNAME: process.env.BOARD_USERNAME,
    BOARD_PASSWORD: process.env.BOARD_PASSWORD,
  });
  if (!auth) {
    logger.warn(
      "Worker administration disabled: set both BOARD_USERNAME and BOARD_PASSWORD to enable it",
    );
    return;
  }

  if (queues.length === 0) {
    logger.warn("No queues found when initializing Workbench");
    return;
  }

  adminApp = createWorkerAdminApp({ queues, auth });
  app.route("/", adminApp);

  logger.info(`Workbench initialized with ${queues.length} queues`, {
    queues: queues.map((q) => q.name),
  });
}

// The lifecycle catches partial initialization and closes every resource created
// so far. Workers do not consume jobs until connections and schedulers are ready.
void lifecycle.start(async (signal) => {
  initializeWorkbench();
  const httpServer = Bun.serve({
    port: Number.parseInt(process.env.PORT || "8080", 10),
    hostname: "0.0.0.0",
    fetch: app.fetch,
  });
  server = httpServer;
  logger.info(`Worker server running on port ${httpServer.port}`);

  for (const queue of queues) {
    queue.on("error", (error) => {
      logger.error("Queue connection error", {
        queue: queue.name,
        error: extractErrorDetails(error),
      });
    });
  }
  for (const config of queueConfigs) {
    workers.push(createConfiguredWorker(config));
  }

  const intervalRaw = process.env.DB_POOL_STATS_INTERVAL_MS;
  const parsedInterval = Number.parseInt(intervalRaw ?? "60000", 10);
  const intervalMs = Number.isFinite(parsedInterval) ? parsedInterval : 60000;
  if (intervalMs > 0) {
    poolStatsInterval = setInterval(() => {
      logger.info("Worker DB pool stats", { pool: getWorkerPoolStats() });
    }, intervalMs);
    poolStatsInterval.unref();
  } else {
    logger.info("Worker DB pool stats logging disabled", {
      configuredIntervalMs: intervalRaw ?? "0",
    });
  }

  await Promise.all([
    checkWorkerHealth(),
    ...queues.map(async (queue) => {
      redisClients.push(await queue.waitUntilReady());
    }),
    ...workers.map(async (worker) => {
      const clients = await Promise.all([
        worker.client,
        worker.waitUntilReady(),
      ]);
      redisClients.push(...clients);
    }),
  ]);
  if (signal.aborted) return;

  await registerStaticSchedulers();
  if (signal.aborted) return;

  for (const worker of workers) {
    const failed = (error: unknown) => {
      if (
        lifecycle.getPhase() === "draining" ||
        lifecycle.getPhase() === "stopped"
      )
        return;
      logger.error("Worker run loop stopped", {
        worker: worker.name,
        error: extractErrorDetails(error),
      });
      Sentry.captureException(error, {
        tags: { workerName: worker.name, errorType: "worker_run" },
      });
      void lifecycle.shutdown(`worker:${worker.name} stopped`, 1);
    };
    void worker
      .run()
      .then(
        () => failed(new Error("Worker run loop exited unexpectedly")),
        failed,
      );
  }
});
