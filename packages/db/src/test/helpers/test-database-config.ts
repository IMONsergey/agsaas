const TEST_DATABASE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "postgres-test",
]);

export class TestDatabaseConfigurationError extends Error {
  constructor(reason: string) {
    super(`Unsafe TEST_DATABASE_URL: ${reason}`);
    this.name = "TestDatabaseConfigurationError";
  }
}

/**
 * This harness runs TRUNCATE CASCADE and schema setup. Never allow it to use
 * production URLs or ambient pg defaults; callers must opt into a local,
 * disposable database explicitly. Error messages intentionally omit values.
 */
export function getTestDatabaseUrl(
  value: string | undefined = process.env.TEST_DATABASE_URL,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TestDatabaseConfigurationError(
      "set an explicit connection URL for the isolated midday_test database",
    );
  }

  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  ) {
    throw new TestDatabaseConfigurationError(
      "whitespace and control characters are not permitted",
    );
  }

  // Check the raw delimiters too: URL.search/hash lose an empty '?' or '#'.
  // pg connection-string query options can override host/database selection.
  if (value.includes("?") || value.includes("#")) {
    throw new TestDatabaseConfigurationError(
      "query parameters and fragments are not permitted",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TestDatabaseConfigurationError(
      "a valid PostgreSQL URL is required",
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new TestDatabaseConfigurationError(
      "only postgres and postgresql protocols are permitted",
    );
  }

  if (!TEST_DATABASE_HOSTS.has(parsed.hostname)) {
    throw new TestDatabaseConfigurationError(
      "only loopback hosts or the postgres-test Compose service are permitted",
    );
  }

  if (parsed.pathname !== "/midday_test") {
    throw new TestDatabaseConfigurationError(
      "the database name must be exactly midday_test",
    );
  }

  if (parsed.search || parsed.hash) {
    throw new TestDatabaseConfigurationError(
      "query parameters and fragments are not permitted",
    );
  }

  return value;
}
