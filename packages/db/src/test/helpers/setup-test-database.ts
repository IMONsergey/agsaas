import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import {
  getTestDatabaseUrl,
  TestDatabaseConfigurationError,
} from "./test-database-config";

export async function setupTestDatabase(): Promise<void> {
  const connectionString = getTestDatabaseUrl();
  const prerequisites = await readFile(
    join(__dirname, "setup-test-db.sql"),
    "utf-8",
  );
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
  });

  try {
    await pool.query(prerequisites);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  setupTestDatabase().catch((error: unknown) => {
    // Driver errors may contain connection information. Never print the URL,
    // password, or the raw error object from this destructive setup harness.
    const message =
      error instanceof TestDatabaseConfigurationError
        ? error.message
        : "Isolated test database setup failed; verify the local Postgres service and SQL prerequisites.";
    console.error(message);
    process.exitCode = 1;
  });
}
