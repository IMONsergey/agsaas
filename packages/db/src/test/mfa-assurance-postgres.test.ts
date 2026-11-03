import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

const migration = readFileSync(
  join(
    __dirname,
    "../../self-hosted/upgrades/supabase/migrations/20261103090001_mfa_assurance.sql",
  ),
  "utf8",
);

describe.skipIf(!isTestDatabaseAvailable())(
  "Data API MFA assurance (real PostgreSQL RLS)",
  () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 1,
        connectionTimeoutMillis: 2000,
      });
    });
    afterAll(async () => {
      await pool?.end();
    });

    async function fixture(client: PoolClient) {
      await client.query("BEGIN");
      // The ordinary test DB is bare Postgres. These rollback-scoped Auth stubs
      // read the same signed-claim GUC contract as PostgREST, not a constant UID.
      await client.query(`

      CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      CREATE TABLE IF NOT EXISTS auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),not_after timestamptz,refreshed_at timestamp,user_agent text,ip inet);
      CREATE TABLE IF NOT EXISTS auth.refresh_tokens(session_id uuid);
      CREATE TABLE IF NOT EXISTS auth.mfa_factors (
        id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
        SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
      $fn$;
    `);
      await client.query(`
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $fn$
        SELECT COALESCE(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
      $fn$;
      GRANT USAGE ON SCHEMA public, private, auth TO authenticated;
      GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO authenticated;
      REVOKE ALL ON auth.mfa_factors FROM PUBLIC, authenticated, anon;
    `);
      // Reconstruct the deployed baseline read policies in this isolated test DB.
      // drizzle-kit carries legacy upstream policies which the self-hosted
      // generator deliberately omits; they must not become a test bypass.
      for (const table of ["users", "teams", "bank_connections"]) {
        const policies = await client.query(
          "SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=$1",
          [table],
        );
        for (const row of policies.rows) {
          const policy = String(row.policyname).replaceAll('"', '""');
          await client.query(`DROP POLICY "${policy}" ON public."${table}"`);
        }
        await client.query(
          `ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`,
        );
      }
      await client.query(`
      CREATE OR REPLACE FUNCTION private.get_teams_for_authenticated_user()
      RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
        SELECT team_id FROM public.users_on_team WHERE user_id=(SELECT auth.uid())
      $fn$;
      GRANT EXECUTE ON FUNCTION private.get_teams_for_authenticated_user() TO authenticated;
      GRANT SELECT ON public.users, public.teams TO authenticated;
      GRANT SELECT(id,team_id), UPDATE(reference_id,expires_at) ON public.bank_connections TO authenticated;
      CREATE POLICY agsaas_profile_read ON public.users FOR SELECT TO authenticated USING(id=(SELECT auth.uid()));
      CREATE POLICY agsaas_team_read ON public.teams FOR SELECT TO authenticated USING(id IN (SELECT private.get_teams_for_authenticated_user()));
      CREATE POLICY agsaas_bank_reconnect_read ON public.bank_connections FOR SELECT TO authenticated USING(team_id IN (SELECT private.get_teams_for_authenticated_user()));
      CREATE POLICY agsaas_bank_reconnect_update ON public.bank_connections FOR UPDATE TO authenticated USING(team_id IN (SELECT private.get_teams_for_authenticated_user())) WITH CHECK(team_id IN (SELECT private.get_teams_for_authenticated_user()));
    `);
      const user = randomUUID();
      const otherUser = randomUUID();
      const team = randomUUID();
      const otherTeam = randomUUID();
      const bank = randomUUID();
      for (const actor of [user, otherUser]) {
        await client.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [
          actor,
          `${actor}@example.test`,
        ]);
        await client.query(
          "INSERT INTO auth.sessions(id,user_id,not_after,refreshed_at) VALUES($1,$2,now()+interval '1 hour',now())",
          [randomUUID(), actor],
        );
      }
      // The self-hosted baseline Auth trigger may already have created profiles.
      await client.query(
        "INSERT INTO public.users(id,email,full_name) VALUES($1,$2,'MFA fixture'),($3,$4,'Other MFA fixture') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,full_name=EXCLUDED.full_name",
        [user, `${user}@example.test`, otherUser, `${otherUser}@example.test`],
      );
      await client.query(
        "INSERT INTO public.teams(id,inbox_id,name) VALUES($1::uuid,$1::text,'MFA team'),($2::uuid,$2::text,'Other MFA team')",
        [team, otherTeam],
      );
      await client.query(
        "INSERT INTO public.users_on_team(user_id,team_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
        [user, team, otherUser, otherTeam],
      );
      await client.query(
        "INSERT INTO public.bank_connections(id,team_id,institution_id,name,provider,reference_id) VALUES($1,$2,'fixture-institution','MFA bank','gocardless','original')",
        [bank, team],
      );
      await client.query(
        readFileSync(
          join(
            __dirname,
            "../../self-hosted/upgrades/supabase/migrations/20261103071000_auth_session_revocation.sql",
          ),
          "utf8",
        ),
      );
      await client.query(migration);
      return { user, otherUser, team, otherTeam, bank };
    }

    async function claims(
      client: PoolClient,
      user: string,
      aal?: string,
      metadata?: unknown,
    ) {
      await client.query("RESET ROLE");
      const session = await client.query(
        "SELECT id FROM auth.sessions WHERE user_id=$1 ORDER BY id LIMIT 1",
        [user],
      );
      await client.query("SELECT set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({
          sub: user,
          session_id: session.rows[0]?.id,
          role: "authenticated",
          ...(aal ? { aal } : {}),
          user_metadata: metadata,
        }),
      ]);
      await client.query("SET LOCAL ROLE authenticated");
    }
    async function teams(client: PoolClient) {
      return (
        await client.query("SELECT id FROM public.teams ORDER BY id")
      ).rows.map((r) => r.id);
    }
    async function factor(client: PoolClient, user: string, status: string) {
      await client.query("RESET ROLE");
      await client.query(
        "INSERT INTO auth.mfa_factors(id,user_id,status) VALUES($1,$2,$3)",
        [randomUUID(), user, status],
      );
    }
    async function run(
      body: (
        client: PoolClient,
        data: Awaited<ReturnType<typeof fixture>>,
      ) => Promise<void>,
    ) {
      const client = await pool.connect();
      try {
        await body(client, await fixture(client));
      } finally {
        try {
          // ROLLBACK also restores SET LOCAL ROLE, including aborted transactions.
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    }

    test("MFA off and unverified enrollment allow AAL1 only for the current tenant", () =>
      run(async (client, f) => {
        await claims(client, f.user, "aal1");
        expect(await teams(client)).toEqual([f.team]);
        expect(
          (await client.query("SELECT id FROM public.users")).rows.map(
            (r) => r.id,
          ),
        ).toEqual([f.user]);
        await factor(client, f.user, "unverified");
        await factor(client, f.otherUser, "verified");
        await claims(client, f.user, "aal1");
        expect(await teams(client)).toEqual([f.team]);
      }));

    test("a factor verified after token issuance immediately blocks AAL1, profile reads and reconnect writes", () =>
      run(async (client, f) => {
        await claims(client, f.user, "aal1");
        expect(await teams(client)).toEqual([f.team]);
        await factor(client, f.user, "verified");
        await claims(client, f.user, "aal1");
        expect(await teams(client)).toEqual([]);
        expect(
          (await client.query("SELECT id FROM public.users")).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(
              "SELECT private.get_teams_for_authenticated_user()",
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(
              "UPDATE public.bank_connections SET reference_id='blocked' WHERE id=$1",
              [f.bank],
            )
          ).rowCount,
        ).toBe(0);
        await client.query("RESET ROLE");
        expect(
          (
            await client.query(
              "SELECT reference_id FROM public.bank_connections WHERE id=$1",
              [f.bank],
            )
          ).rows[0].reference_id,
        ).toBe("original");
      }));

    test("AAL2 restores own-team reads/writes without granting another tenant", () =>
      run(async (client, f) => {
        await factor(client, f.user, "verified");
        await claims(client, f.user, "aal2");
        expect(await teams(client)).toEqual([f.team]);
        expect(
          (
            await client.query(
              "UPDATE public.bank_connections SET reference_id='verified' WHERE id=$1",
              [f.bank],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await client.query("SELECT id FROM public.teams WHERE id=$1", [
              f.otherTeam,
            ])
          ).rows,
        ).toEqual([]);
      }));

    test("missing AAL and editable metadata cannot bypass; removing a factor re-evaluates authoritative state", () =>
      run(async (client, f) => {
        await factor(client, f.user, "verified");
        await claims(client, f.user, undefined, {
          aal: "aal2",
          mfa_enabled: false,
        });
        expect(await teams(client)).toEqual([]);
        await client.query("RESET ROLE");
        await client.query("DELETE FROM auth.mfa_factors WHERE user_id=$1", [
          f.user,
        ]);
        await claims(client, f.user, "aal1");
        expect(await teams(client)).toEqual([f.team]);
      }));

    test("restrictive assurance cannot be overridden by a permissive grant and Auth factors remain private", () =>
      run(async (client, f) => {
        await factor(client, f.user, "verified");
        await client.query(
          "CREATE POLICY synthetic_permissive_read ON public.teams FOR SELECT TO authenticated USING(true)",
        );
        await claims(client, f.user, "aal1");
        expect(await teams(client)).toEqual([]);
        expect(
          (
            await client.query(
              "SELECT has_table_privilege(current_user,'auth.mfa_factors','SELECT') AS allowed",
            )
          ).rows[0].allowed,
        ).toBe(false);
        await client.query("RESET ROLE");
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM pg_policies WHERE policyname='agsaas_authenticated_assurance' AND permissive='RESTRICTIVE'",
            )
          ).rows[0].count,
        ).toBe(9);
      }));

    test("upgrade replay is idempotent and a missing authoritative factor catalog fails closed", () =>
      run(async (client, f) => {
        await client.query(migration);
        await factor(client, f.user, "verified");
        await claims(client, f.user, "aal1");
        expect(await teams(client)).toEqual([]);
        await client.query("RESET ROLE");
        await client.query(
          "ALTER TABLE auth.mfa_factors RENAME TO synthetic_factors_missing",
        );
        await client.query("SAVEPOINT missing_auth");
        await expect(client.query(migration)).rejects.toThrow(
          "Authoritative Auth factor catalog",
        );
        await client.query("ROLLBACK TO SAVEPOINT missing_auth");
      }));
  },
);
