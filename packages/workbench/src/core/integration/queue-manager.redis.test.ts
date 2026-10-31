import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { type FlowProducer, Queue, QueueEvents, Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import { QueueManager } from "../queue-manager";

/**
 * Explicit opt-in only:
 * REDIS_TEST_URL=redis://127.0.0.1:6379/15 bun test --exit src/core/integration
 *
 * No shared keys are removed. Every test creates a random queue and prefix;
 * cleanup obliterates only that test-owned queue.
 */
function readTestConnection(): RedisOptions | undefined {
  const configured = process.env.REDIS_TEST_URL;
  if (!configured) return undefined;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      "REDIS_TEST_URL must be a loopback redis:// URL using DB 15",
    );
  }

  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (
    url.protocol !== "redis:" ||
    !allowedHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    configured.includes("?") ||
    configured.includes("#") ||
    !["", "/", "/15"].includes(url.pathname)
  ) {
    throw new Error(
      "Refusing Redis integration tests: only loopback redis:// URLs with DB 15 and no credentials, query or fragment are allowed",
    );
  }

  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 6379,
    db: 15,
    connectTimeout: 3000,
    maxRetriesPerRequest: null,
    retryStrategy: () => null,
  };
}

const connection = readTestConnection();
const redisSuite = connection ? describe : describe.skip;

type TestContext = {
  queue: Queue;
  events: QueueEvents;
  manager: QueueManager;
  startWorker: (processor: ConstructorParameters<typeof Worker>[1]) => Worker;
};

async function withDeadline<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withIsolatedQueue(
  run: (context: TestContext) => Promise<void>,
): Promise<void> {
  if (!connection) throw new Error("Redis integration tests were not enabled");

  const id = randomUUID();
  const name = `workbench-test-${id}`;
  const prefix = `agsaas:test:${id}`;
  const queue = new Queue(name, { connection, prefix });
  const events = new QueueEvents(name, { connection, prefix });
  const manager = new QueueManager([queue]);
  const workers: Worker[] = [];
  const connectionErrors: Error[] = [];
  const captureConnectionError = (error: Error) => {
    connectionErrors.push(error);
  };
  queue.on("error", captureConnectionError);
  events.on("error", captureConnectionError);

  // QueueManager currently owns an internal FlowProducer without a public
  // disposal API. Close its real connection explicitly in this test fixture.
  const producer = (manager as unknown as { flowProducer: FlowProducer | null })
    .flowProducer;
  producer?.on("error", captureConnectionError);
  const testErrors: unknown[] = [];

  try {
    await withDeadline(
      Promise.all([queue.waitUntilReady(), events.waitUntilReady()]),
      "isolated Redis queue to become ready",
    );
    await run({
      queue,
      events,
      manager,
      startWorker: (processor) => {
        const worker = new Worker(name, processor, {
          connection,
          prefix,
          concurrency: 1,
        });
        worker.on("error", captureConnectionError);
        workers.push(worker);
        return worker;
      },
    });
    if (connectionErrors.length > 0) {
      throw new AggregateError(connectionErrors, "Redis connection errors");
    }
  } catch (error) {
    testErrors.push(error);
  } finally {
    const cleanup = async (
      operation: Promise<unknown>,
      description: string,
    ) => {
      try {
        await withDeadline(operation, description);
      } catch (error) {
        testErrors.push(error);
      }
    };
    await Promise.all([
      ...workers.map((worker) =>
        cleanup(worker.close(true), "close test worker"),
      ),
      cleanup(events.close(), "close test events"),
      ...(producer
        ? [cleanup(producer.close(), "close test flow producer")]
        : []),
    ]);
    try {
      await cleanup(
        queue.obliterate({ force: true }),
        "remove test-owned queue",
      );
    } finally {
      await cleanup(queue.close(), "close test queue");
    }
  }
  if (testErrors.length > 0) {
    throw new AggregateError(
      testErrors,
      "Isolated Redis integration test failed",
    );
  }
}

redisSuite("QueueManager with real Redis / BullMQ", () => {
  it("uses custom prefixes and selects ASC/DESC range candidates before LIMIT", async () => {
    await withIsolatedQueue(async ({ queue, events, manager, startWorker }) => {
      const base = Date.now() - 10_000;
      const jobs = await queue.addBulk(
        Array.from({ length: 20 }, (_, i) => ({
          name: "complete-in-order",
          data: { sequence: i },
          opts: {
            jobId: `range-${String(i).padStart(2, "0")}`,
            timestamp: base + i,
          },
        })),
      );
      startWorker(async () => {
        // Distinct completion scores make the Redis ordering assertion exact.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { completed: true };
      });
      await withDeadline(
        Promise.all(jobs.map((job) => job.waitUntilFinished(events, 10_000))),
        "range test jobs to complete",
      );

      const client = await queue.client;
      expect(await client.zcard(queue.toKey("completed"))).toBe(20);
      expect(await client.exists(`bull:${queue.name}:completed`)).toBe(0);
      const filters = {
        status: "completed" as const,
        timeRange: { start: base - 1000, end: Date.now() + 1000 },
      };
      const newest = await manager.getAllRuns(
        2,
        0,
        { field: "timestamp", direction: "desc" },
        filters,
      );
      const oldest = await manager.getAllRuns(
        2,
        0,
        { field: "timestamp", direction: "asc" },
        filters,
      );
      expect(newest.data.map(({ id }) => id)).toEqual(["range-19", "range-18"]);
      expect(oldest.data.map(({ id }) => id)).toEqual(["range-00", "range-01"]);
      expect(newest.hasMore).toBe(true);
      expect(oldest.hasMore).toBe(true);
    });
  }, 30_000);

  it("keeps later offset pages complete and free of duplicate jobs", async () => {
    await withIsolatedQueue(async ({ queue, manager }) => {
      const base = Date.now() - 1000;
      await queue.addBulk(
        Array.from({ length: 65 }, (_, i) => ({
          name: "waiting-for-pagination",
          data: { sequence: i },
          opts: { jobId: `page-${i}`, timestamp: base + i },
        })),
      );
      const ids: string[] = [];
      for (const start of [0, 20, 40, 60]) {
        const page = await manager.getAllRuns(20, start);
        ids.push(...page.data.map(({ id }) => id));
        expect(page.data).toHaveLength(start === 60 ? 5 : 20);
        expect(page.hasMore).toBe(start !== 60);
        expect(page.cursor).toBe(start === 60 ? undefined : String(start + 20));
      }
      expect(ids).toEqual(
        Array.from({ length: 65 }, (_, i) => `page-${64 - i}`),
      );
      expect(new Set(ids).size).toBe(65);
    });
  }, 30_000);

  it("refreshes real Redis counts and pause state after queue mutations", async () => {
    await withIsolatedQueue(async ({ queue, manager }) => {
      const jobs = await queue.addBulk(
        Array.from({ length: 3 }, (_, i) => ({
          name: "cache-test",
          data: { sequence: i },
          opts: { jobId: `cache-${i}` },
        })),
      );
      expect((await manager.getQuickCounts()).waiting).toBe(3);
      expect((await manager.getQueues())[0]?.counts.waiting).toBe(3);
      expect((await manager.getJob(queue.name, jobs[0].id!))?.status).toBe(
        "waiting",
      );

      expect(await manager.removeJob(queue.name, jobs[0].id!)).toBe(true);
      expect((await manager.getQuickCounts()).waiting).toBe(2);
      expect((await manager.getQueues())[0]?.counts.waiting).toBe(2);
      expect(await manager.getJob(queue.name, jobs[0].id!)).toBeNull();
      await manager.enqueueJob({
        queueName: queue.name,
        jobName: "new-job",
        data: {},
      });
      expect((await manager.getQuickCounts()).waiting).toBe(3);

      await manager.pauseQueue(queue.name);
      expect((await manager.getQueues())[0]?.isPaused).toBe(true);
      await manager.resumeQueue(queue.name);
      expect((await manager.getQueues())[0]?.isPaused).toBe(false);
    });
  }, 30_000);

  it("refreshes cached state after retrying failed and promoting delayed jobs", async () => {
    await withIsolatedQueue(async ({ queue, events, manager, startWorker }) => {
      const failed = await queue.add(
        "fail-on-purpose",
        {},
        {
          jobId: "failed-job",
          attempts: 1,
        },
      );
      const worker = startWorker(async () => {
        throw new Error("intentional integration-test failure");
      });
      await expect(failed.waitUntilFinished(events, 10_000)).rejects.toThrow(
        "intentional integration-test failure",
      );
      await worker.close();
      expect((await manager.getQuickCounts()).failed).toBe(1);
      expect((await manager.getJob(queue.name, failed.id!))?.status).toBe(
        "failed",
      );

      expect(await manager.retryJob(queue.name, failed.id!)).toBe(true);
      expect((await manager.getQuickCounts()).failed).toBe(0);
      expect((await manager.getQuickCounts()).waiting).toBe(1);
      expect((await manager.getJob(queue.name, failed.id!))?.status).toBe(
        "waiting",
      );

      const delayed = await queue.add(
        "delayed-job",
        {},
        {
          jobId: "delayed-job",
          delay: 3_600_000,
        },
      );
      manager.clearCache();
      expect((await manager.getQuickCounts()).delayed).toBe(1);
      expect((await manager.getJob(queue.name, delayed.id!))?.status).toBe(
        "delayed",
      );
      expect(await manager.promoteJob(queue.name, delayed.id!)).toBe(true);
      expect((await manager.getQuickCounts()).delayed).toBe(0);
      expect((await manager.getQuickCounts()).waiting).toBe(2);
      expect((await manager.getJob(queue.name, delayed.id!))?.status).toBe(
        "waiting",
      );
    });
  }, 30_000);
});
