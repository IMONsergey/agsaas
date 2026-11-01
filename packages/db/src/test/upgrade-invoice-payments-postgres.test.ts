import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

// Actual incremental SQL on the guarded disposable database. Every DDL/data
// change is rolled back; no live Supabase/Auth/server connection is used here.
describe.skipIf(!isTestDatabaseAvailable())(
  "invoice payment reservation incremental upgrade (PostgreSQL)",
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
          "../../self-hosted/upgrades/supabase/migrations/20261101060354_reserve_invoice_payments.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });

    test("actual SQL preserves existing invoice data and grants only internal application access", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DROP TABLE public.invoice_payment_reservations");
        // Later migrations also refer to this composite key. Keep their original
        // FK target under a temporary name instead of dropping unrelated tables.
        await client.query(
          "ALTER TABLE public.invoices RENAME CONSTRAINT invoices_id_team_id_key TO payment_fixture_prior_identity_key",
        );
        const teamId = randomUUID();
        const invoiceId = randomUUID();
        await client.query(
          "INSERT INTO public.teams (id,inbox_id,name) VALUES ($1,$1,'Payment upgrade fixture')",
          [teamId],
        );
        await client.query(
          "INSERT INTO public.invoices (id,team_id,amount,currency,status) VALUES ($1,$2,120.05,'USD','unpaid')",
          [invoiceId, teamId],
        );
        await client.query(migration);

        expect(
          (
            await client.query(
              "SELECT amount::text,currency,status FROM public.invoices WHERE id=$1",
              [invoiceId],
            )
          ).rows[0],
        ).toEqual({ amount: "120.05", currency: "USD", status: "unpaid" });
        const {
          rows: [grants],
        } = await client.query(`
        SELECT relrowsecurity AS rls,
          has_table_privilege('agsaas_app','public.invoice_payment_reservations','SELECT, INSERT, UPDATE, DELETE') AS backend,
          has_table_privilege('anon','public.invoice_payment_reservations','SELECT') AS anonymous,
          has_table_privilege('authenticated','public.invoice_payment_reservations','SELECT') AS browser
        FROM pg_class WHERE oid='public.invoice_payment_reservations'::regclass
      `);
        expect(grants).toEqual({
          rls: true,
          backend: true,
          anonymous: false,
          browser: false,
        });
        await client.query("SET LOCAL ROLE agsaas_app");
        const {
          rows: [reservation],
        } = await client.query(
          "INSERT INTO public.invoice_payment_reservations (invoice_id,team_id,stripe_account_id,amount_minor,currency,invoice_number) VALUES ($1,$2,'acct_fixture',12005,'usd','INV-001') RETURNING state",
          [invoiceId, teamId],
        );
        expect(reservation.state).toBe("reserved");
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.invoice_payment_reservations",
            )
          ).rows[0]?.count,
        ).toBe(1);
        await client.query("RESET ROLE");

        await client.query("SAVEPOINT foreign_team");
        await expect(
          client.query(
            "UPDATE public.invoice_payment_reservations SET team_id=$1 WHERE invoice_id=$2",
            [randomUUID(), invoiceId],
          ),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT foreign_team");

        await client.query("SAVEPOINT browser_access");
        await client.query("SET LOCAL ROLE authenticated");
        await expect(
          client.query("SELECT * FROM public.invoice_payment_reservations"),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT browser_access");
        await client.query("DELETE FROM public.teams WHERE id=$1", [teamId]);
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.invoice_payment_reservations",
            )
          ).rows[0]?.count,
        ).toBe(0);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    test("unexpected prior reservation schema is rejected and rolled back", async () => {
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
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoice_payment_reservations' AND column_name='amount_minor') AS restored",
      );
      expect(row.restored).toBe(true);
    });
  },
);
