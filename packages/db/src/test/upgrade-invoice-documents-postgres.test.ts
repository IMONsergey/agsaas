import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "invoice document and tracker integrity incremental upgrade (PostgreSQL rollback fixtures)",
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
          "../../self-hosted/upgrades/supabase/migrations/20261101112557_invoice_documents_and_tracker_integrity.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });
    async function legacy(client: PoolClient) {
      await client.query("BEGIN");
      await client.query(`
      DROP TRIGGER IF EXISTS invoices_document_guard ON public.invoices;
      DROP TRIGGER IF EXISTS tracker_entries_billing_snapshot ON public.tracker_entries;
      DROP FUNCTION IF EXISTS public.capture_tracker_billing();
      DROP FUNCTION IF EXISTS public.guard_invoice_document();
      DROP FUNCTION IF EXISTS public.capture_invoice_document(public.invoices,text);
      DROP TABLE public.invoice_number_counters;
      DROP INDEX public.invoices_team_number_key;
      DROP INDEX public.tracker_entries_one_running_timer;
      ALTER TABLE public.invoices DROP COLUMN document_snapshot;
      ALTER TABLE public.tracker_entries DROP COLUMN billing_snapshot_source;
    `);
      const team = randomUUID();
      const invoice = randomUUID();
      await client.query(
        "INSERT INTO public.teams(id,inbox_id,name) VALUES($1,$2,'Document upgrade fixture')",
        [team, team],
      );
      await client.query(
        "INSERT INTO public.invoices(id,team_id,invoice_number,amount,currency,status,note_details) VALUES($1,$2,'UPGRADE-100',123.45,'USD','unpaid','\"original note\"')",
        [invoice, team],
      );
      return { team, invoice };
    }

    test("actual upgrade preserves financial rows, marks legacy snapshots and restricts the allocator", async () => {
      const client = await pool.connect();
      try {
        const { team, invoice } = await legacy(client);
        await client.query(migration);
        const row = (
          await client.query(
            "SELECT amount::text,currency,invoice_number,document_snapshot FROM public.invoices WHERE id=$1",
            [invoice],
          )
        ).rows[0];
        expect(row).toMatchObject({
          amount: "123.45",
          currency: "USD",
          invoice_number: "UPGRADE-100",
          document_snapshot: {
            version: 1,
            source: "legacy_current",
            document: { amount: 123.45, invoiceNumber: "UPGRADE-100" },
          },
        });
        expect(
          (
            await client.query(
              "SELECT last_number::text AS value FROM public.invoice_number_counters WHERE team_id=$1",
              [team],
            )
          ).rows[0]?.value,
        ).toBe("100");
        expect(
          (
            await client.query(
              `SELECT has_table_privilege('agsaas_app','public.invoice_number_counters','SELECT,INSERT,UPDATE,DELETE') AS backend, has_table_privilege('authenticated','public.invoice_number_counters','SELECT') AS browser, has_table_privilege('anon','public.invoice_number_counters','SELECT') AS anonymous`,
            )
          ).rows[0],
        ).toEqual({ backend: true, browser: false, anonymous: false });
        await client.query(
          "UPDATE public.invoices SET note_details='\"working note\"', status='paid', paid_at=now() WHERE id=$1",
          [invoice],
        );
        await client.query("SAVEPOINT immutable");
        await expect(
          client.query("UPDATE public.invoices SET amount=999 WHERE id=$1", [
            invoice,
          ]),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT immutable");
        expect(
          (
            await client.query(
              "SELECT amount::text,document_snapshot->'document'->>'noteDetails' AS note FROM public.invoices WHERE id=$1",
              [invoice],
            )
          ).rows[0],
        ).toEqual({ amount: "123.45", note: "original note" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    test("legacy time is preserved and new direct DB writes capture immutable project terms", async () => {
      const client = await pool.connect();
      try {
        const { team } = await legacy(client);
        const project = randomUUID();
        const oldEntry = randomUUID();
        await client.query(
          "INSERT INTO public.tracker_projects(id,team_id,name,rate,currency,billable) VALUES($1,$2,'Historical work',100,'USD',true)",
          [project, team],
        );
        await client.query(
          "INSERT INTO public.tracker_entries(id,team_id,project_id,duration,date) VALUES($1,$2,$3,7200,'2026-10-01')",
          [oldEntry, team, project],
        );
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT rate::text,currency,billing_snapshot_source AS source,duration::int FROM public.tracker_entries WHERE id=$1",
              [oldEntry],
            )
          ).rows[0],
        ).toEqual({
          rate: "100.00",
          currency: "USD",
          source: "legacy_current",
          duration: 7200,
        });
        await client.query(
          "UPDATE public.tracker_projects SET rate=150,currency='EUR' WHERE id=$1",
          [project],
        );
        await client.query(
          "UPDATE public.tracker_entries SET description='Only a description',rate=999,currency='GBP' WHERE id=$1",
          [oldEntry],
        );
        expect(
          (
            await client.query(
              "SELECT rate::text,currency FROM public.tracker_entries WHERE id=$1",
              [oldEntry],
            )
          ).rows[0],
        ).toEqual({ rate: "100.00", currency: "USD" });
        const inserted = (
          await client.query(
            "INSERT INTO public.tracker_entries(team_id,project_id,duration,date) VALUES($1,$2,3600,'2026-11-01') RETURNING rate::text,currency,billing_snapshot_source AS source",
            [team, project],
          )
        ).rows[0];
        expect(inserted).toEqual({
          rate: "150.00",
          currency: "EUR",
          source: "recorded",
        });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    test("legacy duplicate invoice numbers abort without renaming or deleting either record", async () => {
      const client = await pool.connect();
      try {
        const { team } = await legacy(client);
        await client.query(
          "INSERT INTO public.invoices(team_id,invoice_number,amount) VALUES($1,' UPGRADE-100 ',88)",
          [team],
        );
        await client.query("SAVEPOINT upgrade");
        await expect(client.query(migration)).rejects.toThrow(
          "Duplicate invoice numbers",
        );
        await client.query("ROLLBACK TO SAVEPOINT upgrade");
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count, sum(amount)::text AS amount FROM public.invoices WHERE team_id=$1",
              [team],
            )
          ).rows[0],
        ).toEqual({ count: 2, amount: "211.45" });
        expect(
          (
            await client.query(
              "SELECT to_regclass('public.invoice_number_counters') AS allocator",
            )
          ).rows[0]?.allocator,
        ).toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    test("legacy concurrent timers abort instead of discarding or guessing recorded time", async () => {
      const client = await pool.connect();
      try {
        const { team } = await legacy(client);
        const user = randomUUID();
        await client.query(
          "INSERT INTO public.users(id,email,full_name) VALUES($1,'timer-upgrade@example.test','Timer fixture')",
          [user],
        );
        await client.query(
          "INSERT INTO public.tracker_entries(team_id,assigned_id,start,duration) VALUES($1,$2,now(),NULL),($1,$2,now()-interval '1 hour',NULL)",
          [team, user],
        );
        await client.query("SAVEPOINT upgrade");
        await expect(client.query(migration)).rejects.toThrow(
          "Multiple running timers",
        );
        await client.query("ROLLBACK TO SAVEPOINT upgrade");
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM public.tracker_entries WHERE team_id=$1 AND stop IS NULL",
              [team],
            )
          ).rows[0]?.count,
        ).toBe(2);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
