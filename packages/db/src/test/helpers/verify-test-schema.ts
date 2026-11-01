import { Pool } from "pg";
import { createApplicationSnapshot } from "../../../self-hosted/generate";
import { getTestDatabaseUrl } from "./test-database-config";

/** drizzle-kit may exit zero after a non-interactive prompt. Verify the actual
 * disposable database before allowing integration tests to report results. */
async function main() {
  const pool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
  try {
    const snapshot = createApplicationSnapshot();
    const columns = await pool.query<{
      table_name: string;
      column_name: string;
    }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
    );
    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    );
    const checks = await pool.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c'",
    );
    const availableColumns = new Set(
      columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
    );
    const availableIndexes = new Set(indexes.rows.map((row) => row.indexname));
    const availableChecks = new Set(checks.rows.map((row) => row.conname));
    const missing: string[] = [];
    for (const table of Object.values(snapshot.tables)) {
      for (const name of Object.keys(table.columns))
        if (!availableColumns.has(`${table.name}.${name}`))
          missing.push(`${table.name}.${name}`);
      for (const name of Object.keys(table.indexes ?? {}))
        if (!availableIndexes.has(name)) missing.push(name);
      for (const name of Object.keys(table.checkConstraints ?? {}))
        if (!availableChecks.has(name)) missing.push(name);
    }
    if (missing.length)
      throw new Error(
        `Isolated test schema is incomplete: ${missing.join(", ")}. Recreate the disposable database before running tests.`,
      );
    console.log(
      `Verified ${Object.keys(snapshot.tables).length} isolated application tables and their required columns, indexes and checks.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith("Isolated test schema")
        ? error.message
        : "Isolated test schema verification failed.",
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  console.error("Isolated test schema verification failed.");
  process.exitCode = 1;
});
