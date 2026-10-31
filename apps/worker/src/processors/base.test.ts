import { beforeEach, describe, expect, mock, test } from "bun:test";
import { type Job, UnrecoverableError } from "bullmq";
import { z } from "zod";
import {
  NonRetryableError,
  UnsupportedFileTypeError,
} from "../utils/error-classification";

// This suite runs in its own Bun process. No telemetry is initialized or sent.
const captureException = mock(
  (_error: unknown, _context?: unknown) => "fixture",
);
mock.module("@sentry/bun", () => ({ captureException }));
const { BaseProcessor } = await import("./base");

class FixtureProcessor extends BaseProcessor<{ value: number }> {
  readonly messages = {
    info: mock((_message: string, _data?: object) => {}),
    error: mock((_message: string, _data?: object) => {}),
    warn: mock((_message: string, _data?: object) => {}),
    debug: mock((_message: string, _data?: object) => {}),
  };

  constructor(
    private readonly run: (job: Job<{ value: number }>) => Promise<unknown>,
  ) {
    super();
    this.logger = { ...this.logger, ...this.messages };
  }

  protected getPayloadSchema() {
    return z.object({ value: z.number() });
  }

  process(job: Job<{ value: number }>) {
    return this.run(job);
  }
}

function makeJob(attemptsMade = 0): Job<{ value: number }> {
  return {
    id: "fixture-job",
    name: "fixture",
    data: { value: 1 },
    opts: { attempts: 3, removeOnComplete: false },
    attemptsMade,
  } as Job<{ value: number }>;
}

describe("BaseProcessor permanent and transient failures", () => {
  beforeEach(() => captureException.mockClear());

  test("preserves explicit permanent error identity and reports a final failure", async () => {
    const cause = new Error("fixture cause");
    const error = new NonRetryableError(
      "fixture rejected",
      cause,
      "validation",
    );
    const processor = new FixtureProcessor(async () => {
      throw error;
    });

    await expect(processor.handle(makeJob())).rejects.toBe(error);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: expect.objectContaining({
          errorCategory: "validation",
          retryable: "false",
          finalAttempt: "true",
        }),
      }),
    );
    expect(processor.messages.error).toHaveBeenCalledWith(
      "Job failed",
      expect.objectContaining({ shouldRetry: false, isNonRetryable: true }),
    );
  });

  test("classified permanent failures become BullMQ unrecoverable errors with cause", async () => {
    const original = new Error("validation failed for fixture");
    const processor = new FixtureProcessor(async () => {
      throw original;
    });

    const error = await processor.handle(makeJob()).catch((failure) => failure);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toBeInstanceOf(NonRetryableError);
    if (!(error instanceof NonRetryableError)) {
      throw new Error("Expected a permanent application error");
    }
    expect(error.message).toBe(original.message);
    expect(error.originalError).toBe(original);
    expect(error.cause).toBe(original);
    expect(error.category).toBe("validation");
    expect(captureException).toHaveBeenCalledWith(original, expect.anything());
  });

  test.each([
    {
      label: "native",
      error: new UnrecoverableError("fixture terminal failure"),
    },
    {
      label: "subclass",
      error: new UnsupportedFileTypeError("fixture/type", "fixture.bin"),
    },
  ])("does not wrap a $label permanent error", async ({ error }) => {
    const processor = new FixtureProcessor(async () => {
      throw error;
    });
    await expect(processor.handle(makeJob())).rejects.toBe(error);
  });

  test("invalid payloads fail before processing and cannot be automatically retried", async () => {
    const processJob = mock(async () => "should not run");
    const processor = new FixtureProcessor(processJob);
    const job = makeJob();
    job.data = { value: "invalid fixture" } as unknown as { value: number };

    const error = await processor.handle(job).catch((failure) => failure);
    expect(error).toBeInstanceOf(UnrecoverableError);
    if (!(error instanceof NonRetryableError)) {
      throw new Error("Expected a permanent payload validation error");
    }
    expect(error.category).toBe("validation");
    expect(processJob).not.toHaveBeenCalled();
  });

  test.each([
    { message: "ECONNRESET fixture" },
    { message: "429 rate limit fixture" },
    { message: "503 service unavailable fixture" },
    { message: "unknown fixture failure" },
  ])("rethrows retryable failure unchanged: $message", async ({ message }) => {
    const original = new Error(message);
    const processor = new FixtureProcessor(async () => {
      throw original;
    });

    await expect(processor.handle(makeJob())).rejects.toBe(original);
    expect(captureException).not.toHaveBeenCalled();
    expect(processor.messages.error).toHaveBeenCalledWith(
      "Job failed",
      expect.objectContaining({ shouldRetry: true }),
    );
  });

  test("reports a retryable error only after the final configured attempt", async () => {
    const original = new Error("network fixture failure");
    const processor = new FixtureProcessor(async () => {
      throw original;
    });
    await expect(processor.handle(makeJob(2))).rejects.toBe(original);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      original,
      expect.objectContaining({
        tags: expect.objectContaining({
          retryable: "true",
          finalAttempt: "true",
        }),
      }),
    );
  });

  test("preserves normal successful processing", async () => {
    const processor = new FixtureProcessor(async (job) => ({
      value: job.data.value,
    }));
    await expect(processor.handle(makeJob())).resolves.toEqual({ value: 1 });
    expect(captureException).not.toHaveBeenCalled();
  });
});
