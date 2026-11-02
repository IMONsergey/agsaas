import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { restoreBaselineBackendAccess } from "./helpers/baseline-backend-access";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "financial queue handoff incremental migration (PostgreSQL)",
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
          "../../self-hosted/upgrades/supabase/migrations/20261101112922_financial_job_handoff_and_tracker_allocations.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });
    test("preserves legacy rows, invents no sends, grants only backend access and freezes intent bytes", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await restoreBaselineBackendAccess(client, [
          "teams",
          "transactions",
          "tracker_projects",
          "tracker_entries",
          "invoices",
        ]);
        await client.query(
          "DROP TABLE public.financial_job_dispatches; DROP TABLE public.manual_transaction_operations; DROP TABLE public.tracker_invoice_allocations; DROP FUNCTION IF EXISTS public.guard_financial_job_identity(); DROP FUNCTION IF EXISTS public.guard_tracker_invoice_allocation() CASCADE; DROP FUNCTION IF EXISTS public.guard_allocated_tracker_entry() CASCADE; DROP FUNCTION IF EXISTS public.release_draft_tracker_allocations() CASCADE;",
        );
        const teamId = randomUUID();
        const transactionId = randomUUID();
        await client.query(
          "INSERT INTO public.teams(id,inbox_id,name) VALUES($1,$2,'Handoff upgrade fixture')",
          [teamId, teamId],
        );
        await client.query(
          "INSERT INTO public.transactions(id,team_id,date,name,method,amount,currency,internal_id,manual) VALUES($1,$2,'2026-11-01','Legacy manual','other',45,'USD',$3,true)",
          [transactionId, teamId, transactionId],
        );
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM public.financial_job_dispatches",
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await client.query(
              "SELECT amount::text AS amount FROM public.transactions WHERE id=$1",
              [transactionId],
            )
          ).rows[0].amount,
        ).toBe("45.00");
        expect(
          (
            await client.query(
              "SELECT has_table_privilege('agsaas_app','public.financial_job_dispatches','SELECT,INSERT,UPDATE,DELETE') AS backend, has_table_privilege('authenticated','public.financial_job_dispatches','SELECT') AS browser, has_table_privilege('anon','public.manual_transaction_operations','SELECT') AS anonymous",
            )
          ).rows[0],
        ).toEqual({ backend: true, browser: false, anonymous: false });
        await client.query("SET LOCAL ROLE agsaas_app");
        const id = randomUUID();
        await client.query(
          "INSERT INTO public.financial_job_dispatches(id,team_id,operation_key,job_name,queue_name,payload,payload_hash) VALUES($1,$2,$3,'enrich-transactions','transactions',$4::jsonb,$5)",
          [
            id,
            teamId,
            "a".repeat(64),
            JSON.stringify({ teamId, transactionIds: [transactionId] }),
            "b".repeat(64),
          ],
        );
        await client.query("SAVEPOINT immutable");
        await expect(
          client.query(
            "UPDATE public.financial_job_dispatches SET payload=$2::jsonb WHERE id=$1",
            [id, JSON.stringify({ teamId, transactionIds: [randomUUID()] })],
          ),
        ).rejects.toThrow("immutable");
        await client.query("ROLLBACK TO SAVEPOINT immutable");
        await client.query(
          "UPDATE public.financial_job_dispatches SET status='completed',payload=NULL WHERE id=$1",
          [id],
        );
        await client.query("SAVEPOINT terminal");
        await expect(
          client.query(
            "UPDATE public.financial_job_dispatches SET status='pending' WHERE id=$1",
            [id],
          ),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT terminal");
        await client.query(
          "INSERT INTO public.manual_transaction_operations(team_id,operation_id,request_hash,transaction_id) VALUES($1,$2,$3,$4)",
          [teamId, randomUUID(), "c".repeat(64), transactionId],
        );
        await client.query("DELETE FROM public.transactions WHERE id=$1", [
          transactionId,
        ]);
        expect(
          (
            await client.query(
              "SELECT transaction_id FROM public.manual_transaction_operations WHERE team_id=$1",
              [teamId],
            )
          ).rows[0].transaction_id,
        ).toBeNull();
        const project = randomUUID();
        const entry = randomUUID();
        const invoice = randomUUID();
        await client.query(
          "INSERT INTO public.tracker_projects(id,team_id,name,billable,rate,currency) VALUES($1,$2,'Allocation fixture',true,100,'USD')",
          [project, teamId],
        );
        await client.query(
          "INSERT INTO public.tracker_entries(id,team_id,project_id,duration,rate,currency,date) VALUES($1,$2,$3,3600,100,'USD','2026-11-01')",
          [entry, teamId, project],
        );
        await client.query(
          "INSERT INTO public.invoices(id,team_id,invoice_number,currency,amount,status) VALUES($1,$2,'ALLOCATION-1','USD',100,'draft')",
          [invoice, teamId],
        );
        await client.query(
          "INSERT INTO public.tracker_invoice_allocations(tracker_entry_id,invoice_id,team_id,duration,rate,currency) VALUES($1,$2,$3,3600,100,'USD')",
          [entry, invoice, teamId],
        );
        expect(
          (
            await client.query(
              "SELECT billed FROM public.tracker_entries WHERE id=$1",
              [entry],
            )
          ).rows[0].billed,
        ).toBe(true);
        await client.query("SAVEPOINT time_immutable");
        await expect(
          client.query(
            "UPDATE public.tracker_entries SET duration=7200 WHERE id=$1",
            [entry],
          ),
        ).rejects.toThrow("cannot be changed");
        await client.query("ROLLBACK TO SAVEPOINT time_immutable");
        await client.query("DELETE FROM public.invoices WHERE id=$1", [
          invoice,
        ]);
        expect(
          (
            await client.query(
              "SELECT billed,duration::int FROM public.tracker_entries WHERE id=$1",
              [entry],
            )
          ).rows[0],
        ).toEqual({ billed: false, duration: 3600 });
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM public.tracker_invoice_allocations WHERE tracker_entry_id=$1",
              [entry],
            )
          ).rows[0].count,
        ).toBe(0);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
