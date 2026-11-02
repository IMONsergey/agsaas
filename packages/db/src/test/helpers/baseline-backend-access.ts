import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";

type FixtureTable =
  | "teams"
  | "transactions"
  | "tracker_projects"
  | "tracker_entries"
  | "invoices";

/** Drizzle's disposable schema omits the installed baseline role grants.
 * Restore only selected parent-table statements from the immutable baseline,
 * inside the caller's rollback transaction, before exercising an upgrade as
 * the nonprivileged application role. Never grant its new tables here. */
export async function restoreBaselineBackendAccess(
  client: PoolClient,
  tables: readonly FixtureTable[],
) {
  const baseline = readFileSync(
    join(
      __dirname,
      "../../../self-hosted/supabase/migrations/20261031154237_application_baseline.sql",
    ),
    "utf8",
  );
  const lines = new Set(baseline.split("\n"));
  for (const table of tables) {
    const policy = `CREATE POLICY "agsaas_backend" ON "${table}" AS PERMISSIVE FOR ALL TO "agsaas_app" USING (true) WITH CHECK (true);`;
    const grant = `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."${table}" TO agsaas_app, service_role;`;
    if (!lines.has(policy) || !lines.has(grant))
      throw new Error(
        "Fixture parent access differs from the installed baseline",
      );
    await client.query(
      `DROP POLICY IF EXISTS agsaas_backend ON public."${table}"`,
    );
    await client.query(policy);
    await client.query(
      `ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`,
    );
    await client.query(grant);
  }
}
