import type { Database, DatabaseWithPrimary } from "@midday/db/client";

type RetryOnPrimaryOptions = {
  maxRetries?: number;
  baseDelay?: number;
  retryOnNull?: boolean;
};

function isRetryableReplicaError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  return [
    "timeout",
    "connection",
    "failed query",
    "canceling statement",
    "cancelled",
  ].some((fragment) => message.includes(fragment));
}

/**
 * Retry helper for database queries that may fail due to replication lag
 * or transient connection issues. Tries replica first, falls back to primary on failure.
 *
 * This preserves the benefit of fast replicas while handling replication lag gracefully.
 *
 * @param db - The database instance (may be a replica)
 * @param fn - The database query function to execute
 * @param options - Configuration options
 * @param options.maxRetries - Maximum number of retry attempts on primary (default: 1)
 * @param options.baseDelay - Base delay in milliseconds for exponential backoff (default: 100)
 * @param options.retryOnNull - If true, retry on primary when result is null/undefined (default: false)
 * @returns The result of the query function
 */
export async function withRetryOnPrimary<T>(
  db: Database,
  fn: (db: Database) => Promise<T>,
  options?: RetryOnPrimaryOptions,
): Promise<T> {
  const {
    maxRetries = 1,
    baseDelay = 100,
    retryOnNull = false,
  } = options ?? {};
  const primaryOnly = (db as DatabaseWithPrimary).usePrimaryOnly;

  const retryPrimary = async (): Promise<T> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // The presence of primaryOnly is checked before retryPrimary is called.
        return await fn(primaryOnly!());
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const delay = baseDelay * 2 ** attempt + Math.random() * 50;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  };

  let result: T;
  try {
    result = await fn(db);
  } catch (error) {
    if (!primaryOnly || !isRetryableReplicaError(error)) {
      throw error;
    }
    return retryPrimary();
  }

  // A missing row on a replica may be replication lag. Retry on primary
  // outside the replica catch so a primary failure is never retried twice.
  if (retryOnNull && result == null && typeof primaryOnly === "function") {
    return retryPrimary();
  }

  return result;
}
