import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "bank cleanup additive migration (PostgreSQL)",
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
          "../../self-hosted/upgrades/supabase/migrations/20261101114309_bank_connection_cleanup.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });
    test("private encrypted retention survives team deletion without any legacy backfill", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DROP TABLE public.bank_connection_cleanups");
        const teamId = randomUUID();
        await client.query(
          "INSERT INTO public.teams(id,inbox_id,name) VALUES($1,$2,'Cleanup upgrade fixture')",
          [teamId, teamId],
        );
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.bank_connection_cleanups",
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await client.query(
              "SELECT relrowsecurity AS rls, has_table_privilege('agsaas_app','public.bank_connection_cleanups','INSERT') AS backend, has_table_privilege('anon','public.bank_connection_cleanups','SELECT') AS anonymous, has_table_privilege('authenticated','public.bank_connection_cleanups','SELECT') AS browser FROM pg_class WHERE oid='public.bank_connection_cleanups'::regclass",
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
          "INSERT INTO public.bank_connection_cleanups(team_id,connection_id,provider,encrypted_payload) VALUES($1,$2,'plaid',$3)",
          [teamId, randomUUID(), "a".repeat(80)],
        );
        await client.query("SAVEPOINT invalid_success");
        await expect(
          client.query(
            "UPDATE public.bank_connection_cleanups SET status='completed'",
          ),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT invalid_success");
        await client.query("RESET ROLE");
        await client.query("DELETE FROM public.teams WHERE id=$1", [teamId]);
        expect(
          (
            await client.query(
              "SELECT status,attempts FROM public.bank_connection_cleanups",
            )
          ).rows,
        ).toEqual([{ status: "pending", attempts: 0 }]);
        await client.query("SAVEPOINT browser_access");
        await client.query("SET LOCAL ROLE authenticated");
        await expect(
          client.query("SELECT * FROM public.bank_connection_cleanups"),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT browser_access");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    test("does not rewrite an existing cleanup schema", async () => {
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
