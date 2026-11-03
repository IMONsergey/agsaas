import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "inbox OAuth intent incremental SQL (PostgreSQL)",
  () => {
    let pool: Pool, migration: string;
    beforeAll(() => {
      pool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      migration = readFileSync(
        join(
          __dirname,
          "../../self-hosted/upgrades/supabase/migrations/20261101111923_inbox_oauth_intents.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });
    test("actual migration keeps profiles, starts empty, and grants only backend access", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DROP TABLE public.inbox_oauth_intents");
        const teamId = randomUUID(),
          actorId = randomUUID();
        await client.query(
          "INSERT INTO public.teams(id,inbox_id,name) VALUES($1::uuid,$1::text,'Inbox migration fixture')",
          [teamId],
        );
        // The real Auth bridge creates the profile before fixture fields are set.
        await client.query(
          `INSERT INTO auth.users(id,email,raw_user_meta_data)
           VALUES($1,$2,jsonb_build_object('full_name','Inbox migration fixture'))
           ON CONFLICT (id) DO UPDATE SET
             email=excluded.email, raw_user_meta_data=excluded.raw_user_meta_data`,
          [actorId, `${actorId}@example.test`],
        );
        await client.query(
          `INSERT INTO public.users(id,team_id,email) VALUES($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET
             team_id=excluded.team_id, email=excluded.email`,
          [actorId, teamId, `${actorId}@example.test`],
        );
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM public.inbox_oauth_intents",
            )
          ).rows[0].count,
        ).toBe(0);
        const {
          rows: [grants],
        } = await client.query(
          "SELECT relrowsecurity AS rls, has_table_privilege('agsaas_app','public.inbox_oauth_intents','SELECT') AND has_table_privilege('agsaas_app','public.inbox_oauth_intents','INSERT') AND has_table_privilege('agsaas_app','public.inbox_oauth_intents','UPDATE') AND has_table_privilege('agsaas_app','public.inbox_oauth_intents','DELETE') AS backend, has_table_privilege('anon','public.inbox_oauth_intents','SELECT') AS anonymous, has_table_privilege('authenticated','public.inbox_oauth_intents','SELECT') AS browser FROM pg_class WHERE oid='public.inbox_oauth_intents'::regclass",
        );
        expect(grants).toEqual({
          rls: true,
          backend: true,
          anonymous: false,
          browser: false,
        });
        await client.query("SET LOCAL ROLE agsaas_app");
        await client.query(
          "INSERT INTO public.inbox_oauth_intents(user_id,team_id,state_hash,browser_nonce_hash,provider,source,aal,expires_at) VALUES($1,$2,$3,$4,'gmail','inbox','aal1',now()+interval '10 minutes')",
          [actorId, teamId, "a".repeat(64), "b".repeat(64)],
        );
        expect(
          (
            await client.query(
              "SELECT provider,source FROM public.inbox_oauth_intents",
            )
          ).rows,
        ).toEqual([{ provider: "gmail", source: "inbox" }]);
        await client.query("RESET ROLE");
        await client.query("SAVEPOINT invalid_lifetime");
        await expect(
          client.query(
            "UPDATE public.inbox_oauth_intents SET expires_at=created_at+interval '11 minutes'",
          ),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT invalid_lifetime");
        await client.query("SAVEPOINT browser_access");
        await client.query("SET LOCAL ROLE authenticated");
        await expect(
          client.query("SELECT * FROM public.inbox_oauth_intents"),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT browser_access");
        await client.query("DELETE FROM public.users WHERE id=$1", [actorId]);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM public.inbox_oauth_intents",
            )
          ).rows[0].count,
        ).toBe(0);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    test("refuses an already upgraded schema instead of replacing pending intents", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(client.query(migration)).rejects.toThrow(
          "Unexpected existing inbox OAuth intent schema",
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
