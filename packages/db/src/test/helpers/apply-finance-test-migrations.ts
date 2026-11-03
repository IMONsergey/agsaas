import { Pool } from "pg";
import { getTestDatabaseUrl } from "./test-database-config";

/** Read-only readiness check. The canonical foundation owns all migration DDL. */
async function main() {
  const pool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const required = [
      "auth.users",
      "storage.objects",
      "public.teams",
      "public.invoices",
      "public.financial_job_dispatches",
      "public.export_snapshots",
      "public.invoice_settlement_entries",
      "public.invoice_settlement_state",
      "public.invoice_refund_requests",
      "public.team_quota_usage",
      "public.team_connector_reservations",
      "public.security_audit_events",
    ];
    const missing = (
      await client.query<{ missing: string[] }>(
        "select ARRAY(select name from unnest($1::text[]) required(name) where to_regclass(name) is null) as missing",
        [required],
      )
    ).rows[0]!.missing;
    if (missing.length)
      throw new Error(
        "Apply the complete reviewed isolated migration chain before finance tests. Missing: " +
          missing.join(", "),
      );
    const guards = (
      await client.query<{ ready: boolean }>(
        "select to_regprocedure('public.validate_invoice_settlement_entry()') is not null and to_regprocedure('public.guard_invoice_refund_request()') is not null and to_regprocedure('public.guard_export_snapshot_identity()') is not null and to_regprocedure('public.guard_shared_report_snapshot()') is not null and to_regprocedure('public.get_team_entitlements(uuid)') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='reports' and column_name='chart_snapshot') as ready",
      )
    ).rows[0]!.ready;
    if (!guards)
      throw new Error("The isolated database lacks required finance guards");
    const historyExists = (
      await client.query<{ ready: boolean }>(
        "select to_regclass('supabase_migrations.schema_migrations') is not null as ready",
      )
    ).rows[0]!.ready;
    if (historyExists) {
      const requiredVersions = [
        "20261031154237",
        "20261103060000",
        "20261103061000",
        "20261103062000",
        "20261103065000",
        "20261103110000",
        "20261103094000",
        "20261103101000",
      ];
      const versions = (
        await client.query<{ version: string }>(
          "select version from supabase_migrations.schema_migrations where version=ANY($1::text[])",
          [requiredVersions],
        )
      ).rows.map((row) => row.version);
      if (requiredVersions.some((version) => !versions.includes(version)))
        throw new Error(
          "The isolated migration history is incomplete for finance tests",
        );
    } else if (
      process.env.AGSAAS_FINANCE_TEST_ALLOW_UNJOURNALED_FIXTURE !== "1"
    ) {
      throw new Error(
        "Canonical isolated migration history is required. The explicit unjournaled-fixture option is only for separately labeled targeted regression, never full-chain acceptance.",
      );
    }
    await client.query("COMMIT");
    console.log(
      historyExists
        ? "Finance prerequisites verified read-only; canonical source/history integrity is owned by the separate full-chain gate. Credentials omitted."
        : "Targeted unjournaled fixture prerequisites verified read-only; this is not full-chain acceptance. Credentials omitted.",
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
