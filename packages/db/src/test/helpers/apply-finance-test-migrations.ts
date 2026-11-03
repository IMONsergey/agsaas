import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { getTestDatabaseUrl } from "./test-database-config";

async function main() {
  // Guarded exactly like the destructive PostgreSQL test harness. Never reads application DB envs.
  const pool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const root = join(
      __dirname,
      "../../../self-hosted/upgrades/supabase/migrations",
    );
    await client.query(
      readFileSync(join(root, "20261103060000_invoice_commands.sql"), "utf8"),
    );
    const table = (
      await client.query("select to_regclass('public.export_snapshots') as id")
    ).rows[0].id;
    if (!table)
      await client.query(
        readFileSync(join(root, "20261103061000_export_snapshots.sql"), "utf8"),
      );
    const columns = await client.query(
      "select 1 from information_schema.columns where table_schema='public' and table_name='reports' and column_name='chart_snapshot'",
    );
    if (!columns.rows.length)
      await client.query(
        readFileSync(
          join(root, "20261103062000_shared_report_snapshots.sql"),
          "utf8",
        ),
      );
    const ledger = (
      await client.query(
        "select to_regclass('public.invoice_settlement_entries') as id",
      )
    ).rows[0].id;
    if (!ledger)
      await client.query(
        readFileSync(join(root, "20261103065000_invoice_ledger.sql"), "utf8"),
      );
    const ledgerGuard = (
      await client.query(
        "select to_regprocedure('public.validate_invoice_settlement_entry()') is not null as ready",
      )
    ).rows[0].ready;
    if (!ledgerGuard)
      throw new Error("Isolated settlement tables lack required SQL guards");
