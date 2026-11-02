import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

// Actual SQL rehearsal on the guarded disposable database only. DDL and all
// fixture changes roll back; run separately from suites with concurrent writes.
describe.skipIf(!isTestDatabaseAvailable())(
  "invoice email outbox incremental upgrade (PostgreSQL)",
  () => {
    let pool: Pool;
    let migration: string;
    beforeAll(() => {
      pool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      migration = readFileSync(
        join(
          __dirname,
          "../../self-hosted/upgrades/supabase/migrations/20261101060507_durable_invoice_email_delivery.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });

    test("real migration enables backend-only RLS and keeps browser roles denied", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DROP TABLE public.invoice_email_deliveries");
        await client.query(migration);
        const {
          rows: [row],
        } = await client.query(`
        SELECT relrowsecurity AS rls,
          (has_table_privilege('agsaas_app', 'public.invoice_email_deliveries', 'SELECT')
            AND has_table_privilege('agsaas_app', 'public.invoice_email_deliveries', 'INSERT')
            AND has_table_privilege('agsaas_app', 'public.invoice_email_deliveries', 'UPDATE')
            AND has_table_privilege('agsaas_app', 'public.invoice_email_deliveries', 'DELETE')) AS backend,
          has_table_privilege('anon', 'public.invoice_email_deliveries', 'SELECT') AS anonymous,
          has_table_privilege('authenticated', 'public.invoice_email_deliveries', 'SELECT') AS browser
        FROM pg_class WHERE oid = 'public.invoice_email_deliveries'::regclass
      `);
        expect(row).toEqual({
          rls: true,
          backend: true,
          anonymous: false,
          browser: false,
        });
        const {
          rows: [fk],
        } = await client.query(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.invoice_email_deliveries'::regclass AND conname='invoice_email_deliveries_invoice_id_fkey'`,
        );
        expect(fk.definition).toContain("FOREIGN KEY (invoice_id, team_id)");
        expect(fk.definition).toContain(
          "REFERENCES invoices(id, team_id) ON DELETE CASCADE",
        );
        await client.query("SET LOCAL ROLE agsaas_app");
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.invoice_email_deliveries",
            )
          ).rows[0]?.count,
        ).toBe(0);
        await client.query("RESET ROLE");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    test("unexpected existing table fails instead of silently accepting an incompatible schema", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(client.query(migration)).rejects.toThrow();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      const {
        rows: [row],
      } = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoice_email_deliveries' AND column_name='envelope_hash') AS restored",
      );
      expect(row.restored).toBe(true);
    });
  },
);
