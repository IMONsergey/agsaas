import { createLoggerWithContext } from "@midday/logger";
import type { QueueOptions } from "bullmq";
import { Queue } from "bullmq";
import { createQueueRegistry } from "./queue-registry";
import { parseRedisQueueUrl } from "./redis-url";

// Create logger for queue events
const logger = createLoggerWithContext("job-client");

/**
 * Parse Redis URL into connection options for BullMQ
 * BullMQ will create and manage its own Redis connection
 */
function getConnectionOptions() {
  const connection = parseRedisQueueUrl(process.env.REDIS_QUEUE_URL);
  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.RAILWAY_ENVIRONMENT === "production";

  return {
    ...connection,
    // BullMQ required settings
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Network settings — Railway private networking is IPv4 only
    family: 4,
    keepAlive: 30000,
    lazyConnect: false,
    // Production settings
    ...(isProduction && {
      connectTimeout: 15000,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
      enableOfflineQueue: false,
    }),
  };
}

/**
 * Get or create a BullMQ Queue instance
 */
function createQueue(queueName: string): Queue {
  const queueOptions: QueueOptions = {
    connection: getConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: {
        age: 24 * 3600, // Keep completed jobs for 24 hours
        count: 1000, // Keep max 1000 completed jobs
      },
      removeOnFail: {
        age: 7 * 24 * 3600, // Keep failed jobs for 7 days
      },
    },
  };

  const queue = new Queue(queueName, queueOptions);

  // Always attach error handler to prevent unhandled errors
  // See: https://docs.bullmq.io/guide/going-to-production#log-errors
  queue.on("error", (err) => {
    logger.error("Queue error", { queueName, error: err.message });
  });

  logger.info("Queue created", { queueName });

  return queue;
}

const registry = createQueueRegistry(createQueue);

export const getQueue = registry.getQueue;

/**
 * Get all registered queue names
 */
export const getQueueNames = registry.getQueueNames;

/** Close enqueueing connections once, after in-flight producers have drained. */
export const closeQueues = registry.closeQueues;

/**
 * Export connection options for use by workers
 */
export { getConnectionOptions };
