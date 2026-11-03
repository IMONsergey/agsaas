import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { getTestDatabaseUrl } from "./test-database-config";

async function main() {
  const pool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const required = [
      "auth.users",
      "auth.sessions",
      "auth.mfa_factors",
      "storage.objects",
      "storage.buckets",
      "public.teams",
      "public.invoices",
      "public.financial_job_dispatches",
      "public.export_snapshots",
      "public.invoice_settlement_entries",
      "public.invoice_settlement_state",
      "public.bank_connection_cleanups",
      "public.security_audit_events",
      "public.resource_cleanups",
      "public.storage_deletion_tombstones",
      "public.request_resource_budgets",
      "public.heavy_job_admissions",
      "public.resource_admission_reconciliations",
    ];
    const missing = (
      await client.query<{ missing: string[] }>(
        "select ARRAY(select name from unnest($1::text[]) required(name) where to_regclass(name) is null) as missing",
        [required],
      )
    ).rows[0]!.missing;
    const storageGuards = (
      await client.query<{ ready: boolean }>(
        "select to_regprocedure('private.guard_live_storage_object()') is not null and to_regprocedure('private.can_write_public_image(text,text)') is not null as ready",
      )
    ).rows[0]!.ready;
    if (missing.length || !storageGuards)
      throw new Error(
        "Apply the complete reviewed isolated dependency chain (including 094000/095000/100000) before quota acceptance. Missing: " +
          missing.join(", "),
      );
    const { rows } = await client.query(
      "select to_regclass('public.team_quota_usage') as id",
    );
    if (!rows[0].id)
      await client.query(
        readFileSync(
          join(
            __dirname,
            "../../../self-hosted/upgrades/supabase/migrations/20261103101000_team_entitlements.sql",
          ),
          "utf8",
        ),
      );
    const guard = (
      await client.query(
        "select to_regprocedure('public.agsaas_resource_quota()') is not null as ready",
      )
    ).rows[0].ready;
    if (!guard)
      throw new Error(
        "Quota schema exists without its required admission guards",
      );
    await client.query("COMMIT");
    console.log(
      "Targeted isolated entitlement migration ready; full-chain acceptance remains separate; credentials omitted",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
