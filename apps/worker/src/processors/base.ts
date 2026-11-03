import { randomUUID } from "node:crypto";
import {
  ResourceBudgetExceededError,
  withHeavyJobAdmission,
} from "@midday/db/queries/resource-admission";
import {
  captureWorkerQueuedJobReservation,
  queuePayloadTeam,
  releaseQueuedJob,
} from "@midday/job-client/resource-admission";
import { createLoggerWithContext } from "@midday/logger";
import { diagnosticSummary } from "@midday/logger/diagnostics";
import * as Sentry from "@sentry/bun";
import type { Job } from "bullmq";
import { DelayedError } from "bullmq";
import type { ZodSchema } from "zod";
import { getDb } from "../utils/db";
import {
  classifyError,
  getMaxRetries,
  getRetryDelay,
  isNonRetryableError,
  NonRetryableError,
} from "../utils/error-classification";
import { extractErrorDetails } from "../utils/error-details";

const admissionOwnerRunId = randomUUID();
const heavyJobs = new Set([
  "export-team-data",
  "export-transactions",
  "process-export",
  "import-transactions",
  "classify-document",
  "classify-image",
  "process-attachment",
  "process-transaction-attachment",
  "enrich-transactions",
  "sync-bank-connection",
]);

/**
 * Base processor class with error handling, retries, and logging
 */
export abstract class BaseProcessor<TData = unknown> {
  protected logger: ReturnType<typeof createLoggerWithContext>;

  constructor() {
    this.logger = createLoggerWithContext(`worker:${this.constructor.name}`);
  }

  /**
   * Optional Zod schema for payload validation
   * Override this in subclasses to enable automatic payload validation
   */
  protected getPayloadSchema(): ZodSchema<TData> | null {
    return null;
  }

  /** A processor handling legacy credential-bearing data can redact telemetry
   * without mutating the retained Redis payload needed for reconciliation. */
  protected getDiagnosticPayload(job: Job<TData>): unknown {
    return diagnosticSummary(job.data);
  }

  /**
   * Process the job
   * Override this method in subclasses
   */
  abstract process(job: Job<TData>): Promise<unknown>;

  /**
   * Validate job payload using Zod schema if provided
   */
  protected validatePayload(job: Job<TData>): TData {
    const schema = this.getPayloadSchema();
    if (!schema) {
      return job.data;
    }

    try {
      return schema.parse(job.data) as TData;
    } catch (error) {
      this.logger.error("Payload validation failed", {
        jobId: job.id,
        jobName: job.name,
        error: error instanceof Error ? error.message : "Unknown error",
        diagnostics: diagnosticSummary(this.getDiagnosticPayload(job)),
      });
      throw new NonRetryableError(
        `Invalid job payload: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
        "validation",
      );
    }
  }

  /**
   * Main handler called by BullMQ worker
   */
  async handle(job: Job<TData>): Promise<unknown> {
    const startTime = Date.now();
    const admissionTeamId = queuePayloadTeam(job.data);
    let releaseAdmission = true;
    let admissionGeneration: string | null = null;

    this.logger.info("Processing job", {
      jobId: job.id,
      jobName: job.name,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts,
    });

    try {
      if (admissionTeamId && job.id) {
        // Capture before this attempt can finish. A later explicit retry owns
        // another generation; this worker may only release its original slot.
        const reservation = await captureWorkerQueuedJobReservation(
          job.queueName,
          job.id,
          admissionTeamId,
          job.token,
        );
        admissionGeneration = reservation?.generation ?? null;
      }
      // Validate payload if schema is provided (throws on validation error)
      // Store the validated data and update job.data to include any Zod transformations/defaults
      const validatedData = this.validatePayload(job);
      job.data = validatedData;

      // Check idempotency
      const shouldProcess = await this.shouldProcess(job);
      if (!shouldProcess) {
        this.logger.info("Skipping job due to idempotency check", {
          jobId: job.id,
          jobName: job.name,
          idempotencyKey: this.getIdempotencyKey(job),
        });
        return { skipped: true, reason: "idempotency" };
      }

      // Update progress if job has progress tracking
      if (job.opts.removeOnComplete !== false) {
        await this.updateProgress(
          job,
          this.ProgressMilestones.STARTED,
          "Job started",
        );
      }

      // Process with the job (now contains validated/transformed data, preserves prototype methods)
      const result =
        admissionTeamId && heavyJobs.has(job.name)
          ? await withHeavyJobAdmission(
              getDb(),
              {
                teamId: admissionTeamId,
                userId: (job.data as { userId?: string })?.userId,
                jobKey: `${job.queueName}:${job.id}`,
                ownerRunId: admissionOwnerRunId,
              },
              () => this.process(job),
            )
          : await this.process(job);

      const duration = Date.now() - startTime;

      // Wrap logger call in try-catch to prevent stream errors from crashing the job
      // This can happen when pino-pretty transport's stream is closing
      try {
        this.logger.info("Job completed", {
          jobId: job.id,
          jobName: job.name,
          duration: `${duration}ms`,
          hasResult: result !== undefined,
          resultType: typeof result,
        });
      } catch (_logError) {
        // Silently ignore logger errors - job already completed successfully
        // This prevents stream encoding errors from affecting job completion
      }

      // Ensure result is JSON-serializable for BullMQ
      // BullMQ stores return values as JSON strings in Redis
      if (result !== undefined && result !== null) {
        try {
          // Test serialization to ensure it's valid JSON
          const serialized = JSON.stringify(result);
          // Check result size (BullMQ has limits, typically 512MB)
          const sizeInMB = new Blob([serialized]).size / (1024 * 1024);
          if (sizeInMB > 100) {
            this.logger.warn("Large job result detected", {
              jobId: job.id,
              jobName: job.name,
              sizeMB: sizeInMB.toFixed(2),
            });
          }
        } catch (error) {
          this.logger.error("Result is not JSON-serializable", {
            jobId: job.id,
            jobName: job.name,
            error: error instanceof Error ? error.message : "Unknown error",
            resultType: typeof result,
            resultKeys:
              result && typeof result === "object"
                ? Object.keys(result)
                : undefined,
          });
          throw new Error(
            `Job result is not JSON-serializable: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      }

      return result;
    } catch (error) {
      if (error instanceof ResourceBudgetExceededError && job.token) {
        releaseAdmission = false;
        await job.moveToDelayed(Date.now() + 10_000, job.token);
        throw new DelayedError();
      }
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : undefined;
      const errorDetails = extractErrorDetails(error);
      const classified = classifyError(error);

      // Check if this is a non-retryable error
      const isNonRetryable = isNonRetryableError(error);
      const shouldRetry = classified.retryable && !isNonRetryable;
      const remainingAttempts =
        (job.opts.attempts ?? 3) - (job.attemptsMade + 1);
      if (shouldRetry && remainingAttempts > 0) releaseAdmission = false;

      this.logger.error("Job failed", {
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts,
        remainingAttempts,
        duration: `${duration}ms`,
        error: errorMessage,
        errorCategory: classified.category,
        retryable: classified.retryable,
        isNonRetryable,
        shouldRetry,
        suggestedRetryDelay: getRetryDelay(error),
        suggestedMaxRetries: getMaxRetries(error),
        stack: errorStack,
        errorDetails,
      });

      // Only send to Sentry on final attempt or non-retryable errors
      // Avoids noise from retryable failures that will succeed on retry
      if (!shouldRetry || remainingAttempts <= 0) {
        Sentry.captureException(error, {
          tags: {
            jobName: job.name,
            errorCategory: classified.category,
            retryable: String(shouldRetry),
            finalAttempt: String(!shouldRetry || remainingAttempts <= 0),
          },
          extra: {
            jobId: job.id,
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts,
            remainingAttempts,
            duration: `${duration}ms`,
            diagnostics: diagnosticSummary(this.getDiagnosticPayload(job)),
          },
        });
      }

      if (!shouldRetry) {
        this.logger.info("Failing job without further automatic retries", {
          jobId: job.id,
          jobName: job.name,
          category: classified.category,
        });
        // Preserve existing permanent errors (including their subclass metadata).
        // Wrap classified permanent errors in an actual BullMQ UnrecoverableError
        // subclass instead of merely logging that retries have been disabled.
        throw isNonRetryable
          ? error
          : new NonRetryableError(errorMessage, error, classified.category);
      }

      // Re-throw original error for retryable cases
      throw error;
    } finally {
      if (
        releaseAdmission &&
        admissionTeamId &&
        job.id &&
        admissionGeneration
      ) {
        try {
          await releaseQueuedJob(
            job.queueName,
            job.id,
            admissionTeamId,
            admissionGeneration,
          );
        } catch {
          this.logger.warn("Job admission cleanup deferred", { jobId: job.id });
        }
      }
    }
  }

  /**
   * Update job progress
   * @param job - The BullMQ job
   * @param progress - Progress percentage (0-100)
   * @param message - Optional progress message
   */
  protected async updateProgress(
    job: Job<TData>,
    progress: number,
    message?: string,
    step?: string,
  ): Promise<void> {
    // Clamp progress to 0-100
    const clampedProgress = Math.max(0, Math.min(100, progress));

    try {
      // Check if updateProgress method exists and is callable
      // Some job types or BullMQ versions may not have this method
      if (job.updateProgress && typeof job.updateProgress === "function") {
        await job.updateProgress({
          progress: clampedProgress,
          message,
          step,
        });
        this.logger.debug("Progress updated", {
          jobId: job.id,
          progress: `${clampedProgress}%`,
          message,
          step,
        });
      } else {
        // Silently skip if updateProgress is not available
        this.logger.debug("Progress update skipped (method not available)", {
          jobId: job.id,
          progress: `${clampedProgress}%`,
          message,
          step,
        });
      }
    } catch (error) {
      // Don't fail the job if progress update fails
      this.logger.warn("Failed to update job progress", {
        jobId: job.id,
        progress: clampedProgress,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Standard progress milestones for common job patterns
   */
  protected readonly ProgressMilestones = {
    STARTED: 0,
    VALIDATED: 5,
    FETCHED: 10,
    PROCESSING: 25,
    HALFWAY: 50,
    NEARLY_DONE: 75,
    FINALIZING: 90,
    COMPLETED: 100,
  } as const;

  /**
   * Check if a job should be processed (idempotency check)
   * Override this in subclasses to implement custom idempotency logic
   * @param job - The BullMQ job
   * @returns true if job should be processed, false if it should be skipped
   */
  protected async shouldProcess(_job: Job<TData>): Promise<boolean> {
    // Default: always process
    // Subclasses can override to implement idempotency checks
    return true;
  }

  /**
   * Generate an idempotency key for a job
   * Override this in subclasses to generate custom idempotency keys
   * @param job - The BullMQ job
   * @returns An idempotency key string or null if no key should be used
   */
  protected getIdempotencyKey(job: Job<TData>): string | null {
    // Default: use job ID as idempotency key
    // Subclasses can override to generate more specific keys
    return job.id ?? null;
  }
}
