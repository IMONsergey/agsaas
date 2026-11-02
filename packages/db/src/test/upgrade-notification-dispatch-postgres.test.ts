import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "generic dispatch additive migration (PostgreSQL)",
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
          "../../self-hosted/upgrades/supabase/migrations/20261101111052_generic_notification_dispatch.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });
    test("creates no legacy sends, grants only backend access and enforces payload tenant", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DROP TABLE public.notification_dispatches");
        const teamId = randomUUID();
        await client.query(
          "INSERT INTO public.teams(id,inbox_id,name) VALUES($1,$2,'Dispatch upgrade fixture')",
          [teamId, teamId],
        );
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.notification_dispatches",
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await client.query(
              "SELECT relrowsecurity AS rls, has_table_privilege('agsaas_app','public.notification_dispatches','INSERT') AS backend, has_table_privilege('anon','public.notification_dispatches','SELECT') AS anonymous, has_table_privilege('authenticated','public.notification_dispatches','SELECT') AS browser FROM pg_class WHERE oid='public.notification_dispatches'::regclass",
            )
          ).rows[0],
        ).toEqual({
          rls: true,
          backend: true,
          anonymous: false,
          browser: false,
        });
        await client.query("SET LOCAL ROLE agsaas_app");
        await client.query(
          "INSERT INTO public.notification_dispatches(team_id,operation_key,kind,source_job_id,payload,payload_hash) VALUES($1,$2,'notification','fixture',$3::jsonb,$4)",
          [
            teamId,
            "a".repeat(64),
            JSON.stringify({ teamId, type: "invoice_paid" }),
            "b".repeat(64),
          ],
        );
        expect(
          (
            await client.query(
              "SELECT status,attempts FROM public.notification_dispatches",
            )
          ).rows,
        ).toEqual([{ status: "pending", attempts: 0 }]);
        await client.query("SAVEPOINT wrong_scope");
        await expect(
          client.query(
            "UPDATE public.notification_dispatches SET payload=$1::jsonb",
            [JSON.stringify({ teamId: randomUUID() })],
          ),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT wrong_scope");
        await client.query("RESET ROLE");
        await client.query("SAVEPOINT browser_access");
        await client.query("SET LOCAL ROLE authenticated");
        await expect(
          client.query("SELECT * FROM public.notification_dispatches"),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT browser_access");
        await client.query("DELETE FROM public.teams WHERE id=$1", [teamId]);
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.notification_dispatches",
            )
          ).rows[0].count,
        ).toBe(0);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    test("refuses an already upgraded schema without a rewrite", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(client.query(migration)).rejects.toThrow(
          "Unexpected existing",
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
