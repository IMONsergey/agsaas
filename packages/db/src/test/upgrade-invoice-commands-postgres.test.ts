import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "invoice commands incremental migration (PostgreSQL)",
  () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
    });
    afterAll(async () => {
      await pool?.end();
    });
    test("preserves existing intents, creates no historical sends and allows only the intended new queue pair", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const before = (
          await client.query(
            "SELECT count(*)::int AS count FROM public.financial_job_dispatches",
          )
        ).rows[0].count;
        await client.query(
          readFileSync(
            join(
              __dirname,
              "../../self-hosted/upgrades/supabase/migrations/20261103060000_invoice_commands.sql",
            ),
            "utf8",
          ),
        );
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM public.financial_job_dispatches",
            )
          ).rows[0].count,
        ).toBe(before);
        const team = randomUUID();
        await client.query(
          "INSERT INTO public.teams(id,inbox_id,name) VALUES($1::uuid,$1::text,'Invoice migration fixture')",
          [team],
        );
        await client.query(
          "INSERT INTO public.financial_job_dispatches(team_id,operation_key,job_name,queue_name,payload,payload_hash) VALUES($1,$2,'send-invoice-email','invoices',$3::jsonb,$4)",
          [
            team,
            "a".repeat(64),
            JSON.stringify({ teamId: team }),
            "b".repeat(64),
          ],
        );
        await client.query("SAVEPOINT invalid_queue");
        await expect(
          client.query(
            "INSERT INTO public.financial_job_dispatches(team_id,operation_key,job_name,queue_name,payload,payload_hash) VALUES($1,$2,'send-invoice-email','transactions',$3::jsonb,$4)",
            [
              team,
              "c".repeat(64),
              JSON.stringify({ teamId: team }),
              "d".repeat(64),
            ],
          ),
        ).rejects.toThrow("financial_job_dispatches_queue_check");
        await client.query("ROLLBACK TO SAVEPOINT invalid_queue");
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM public.financial_job_dispatches WHERE team_id=$1",
              [team],
            )
          ).rows[0].count,
        ).toBe(1);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
