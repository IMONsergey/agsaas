import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type Job,
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
} from "bullmq";
import { z } from "zod";
import {
  NonRetryableError,
  UnsupportedFileTypeError,
} from "../utils/error-classification";
import { readRetryTestConnection } from "./fixtures/retry-test-connection";

// Isolated process, explicit local disposable Redis only. No provider or
// telemetry client is initialized, and no existing queue/database is flushed.
// REDIS_TEST_URL=redis://127.0.0.1:6379/15 bun test --exit src/processors/base.redis.test.ts
mock.module("@sentry/bun", () => ({ captureException: () => "fixture" }));
const { BaseProcessor } = await import("./base");
const connection = readRetryTestConnection(process.env.REDIS_TEST_URL);
const redisSuite = connection ? describe : describe.skip;

const payloadSchema = z.object({
  behavior: z.enum([
    "explicit-permanent",
    "classified-permanent",
    "subclass-permanent",
    "native-permanent",
    "transient",
    "retry-exhausted",
    "success",
  ]),
});
type Payload = z.infer<typeof payloadSchema>;

class RetryFixtureProcessor extends BaseProcessor<Payload> {
  constructor(readonly calls: Map<string, number>) {
    super();
    // Fixture payloads are not useful log output; assertions below inspect the
    // actual failed/completed jobs and errors from the real BullMQ Worker.
    const ignore = () => {};
    this.logger = {
      ...this.logger,
      info: ignore,
      error: ignore,
      warn: ignore,
      debug: ignore,
    };
  }

  protected getPayloadSchema() {
    return payloadSchema;
  }

  async process(job: Job<Payload>) {
    this.calls.set(job.name, (this.calls.get(job.name) ?? 0) + 1);
    switch (job.data.behavior) {
      case "explicit-permanent":
        throw new NonRetryableError(
          "explicit permanent fixture",
          Object.assign(new Error("original fixture cause"), {
            code: "FIXTURE_CODE",
          }),
          "validation",
        );
      case "classified-permanent":
        throw new Error("validation failed for fixture");
      case "subclass-permanent":
        throw new UnsupportedFileTypeError("fixture/type", "fixture.bin");
      case "native-permanent":
        throw new UnrecoverableError("native permanent fixture");
      case "transient":
        if (job.attemptsMade === 0) throw new Error("ECONNRESET fixture");
        return { recovered: true };
      case "retry-exhausted":
        throw new Error("503 service unavailable fixture");
      case "success":
        return { succeeded: true };
    }
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Retry fixture timed out: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

redisSuite("BaseProcessor retry contract with real Redis/BullMQ", () => {
  test("permanent failures stop once while transient attempts retry and can recover", async () => {
    if (!connection) throw new Error("Explicit Redis test opt-in is required");
    const id = randomUUID();
    const name = `retry-contract-${id}`;
    const prefix = `agsaas:test:retry:${id}`;
    const queue = new Queue(name, { connection, prefix });
    const events = new QueueEvents(name, { connection, prefix });
    const processCalls = new Map<string, number>();
    const handleCalls = new Map<string, number>();
    const finalErrors = new Map<string, Error>();
    const processor = new RetryFixtureProcessor(processCalls);
    const failures: unknown[] = [];
    const connectionErrors: Error[] = [];
    queue.on("error", (error) => connectionErrors.push(error));
    events.on("error", (error) => connectionErrors.push(error));
    let worker: Worker<Payload> | undefined;

    try {
      await withDeadline(
        Promise.all([queue.waitUntilReady(), events.waitUntilReady()]),
        "queue readiness",
      );
      worker = new Worker<Payload>(
        name,
        async (job) => {
          handleCalls.set(job.name, (handleCalls.get(job.name) ?? 0) + 1);
          return processor.handle(job);
        },
        { connection, prefix, concurrency: 1 },
      );
      worker.on("error", (error) => connectionErrors.push(error));
      worker.on("failed", (job, error) => {
        if (job) finalErrors.set(job.name, error);
      });
      await withDeadline(worker.waitUntilReady(), "worker readiness");

      const names = [
        ...payloadSchema.shape.behavior.options,
        "invalid-payload",
      ];
      const jobs = await queue.addBulk(
        names.map((behavior) => ({
          name: behavior,
          data: { behavior },
          opts: {
            jobId: behavior,
            attempts: 4,
            backoff: { type: "fixed", delay: 10 },
            removeOnComplete: false,
            removeOnFail: false,
          },
        })),
      );
      const outcomes = await withDeadline(
        Promise.all(
          jobs.map((job) =>
            job.waitUntilFinished(events, 8_000).then(
              (value) => ({ state: "completed", name: job.name, value }),
              (error: unknown) => ({ state: "failed", name: job.name, error }),
            ),
          ),
        ),
        "actual job outcomes",
      );

      const permanentNames = [
        "explicit-permanent",
        "classified-permanent",
        "subclass-permanent",
        "native-permanent",
        "invalid-payload",
      ];
      for (const permanentName of permanentNames) {
        const job = await queue.getJob(permanentName);
        expect(job).toBeDefined();
        expect(await job!.getState()).toBe("failed");
        expect(job!.attemptsMade).toBe(1);
        expect(handleCalls.get(permanentName)).toBe(1);
        expect(
          outcomes.find((outcome) => outcome.name === permanentName)?.state,
        ).toBe("failed");
        expect(finalErrors.get(permanentName)).toBeInstanceOf(
          UnrecoverableError,
        );
      }
      expect(processCalls.has("invalid-payload")).toBe(false);
      expect(finalErrors.get("explicit-permanent")).toMatchObject({
        name: "NonRetryableError",
        category: "validation",
        cause: { code: "FIXTURE_CODE" },
        originalError: { code: "FIXTURE_CODE" },
      });
      expect(finalErrors.get("subclass-permanent")).toMatchObject({
        name: "UnsupportedFileTypeError",
        mimetype: "fixture/type",
        fileName: "fixture.bin",
      });

      const recovered = await queue.getJob("transient");
      expect(await recovered!.getState()).toBe("completed");
      expect(recovered!.attemptsMade).toBe(2);
      expect(recovered!.returnvalue).toEqual({ recovered: true });
      expect(handleCalls.get("transient")).toBe(2);
      const exhausted = await queue.getJob("retry-exhausted");
      expect(await exhausted!.getState()).toBe("failed");
      expect(exhausted!.attemptsMade).toBe(4);
      expect(handleCalls.get("retry-exhausted")).toBe(4);
      expect(finalErrors.get("retry-exhausted")).not.toBeInstanceOf(
        UnrecoverableError,
      );
      expect((await queue.getJob("success"))!.returnvalue).toEqual({
        succeeded: true,
      });
      expect(handleCalls.get("success")).toBe(1);
      expect(
        await queue.getJobCounts("waiting", "active", "delayed"),
      ).toMatchObject({
        waiting: 0,
        active: 0,
        delayed: 0,
      });
      expect(connectionErrors).toEqual([]);
    } catch (error) {
      failures.push(error);
    } finally {
      const cleanup = async (operation: Promise<unknown>, label: string) => {
        try {
          await withDeadline(operation, label);
        } catch (error) {
          failures.push(error);
        }
      };
      await Promise.all([
        ...(worker ? [cleanup(worker.close(true), "close owned worker")] : []),
        cleanup(events.close(), "close owned events"),
      ]);
      try {
        // A fresh UUID identifies this exact queue; no SCAN/FLUSHDB/shared cleanup.
        await cleanup(queue.obliterate({ force: true }), "remove owned queue");
      } finally {
        await cleanup(queue.close(), "close owned queue");
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Isolated retry contract failed");
  }, 30_000);
});
