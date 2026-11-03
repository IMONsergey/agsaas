import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

const sqlFile = (name: string) =>
  readFileSync(
    join(__dirname, "../../self-hosted/upgrades/supabase/migrations", name),
    "utf8",
  );
const access = () => sqlFile("20261103093100_storage_bucket_access.sql");

describe.skipIf(!isTestDatabaseAvailable())(
  "Storage upload ownership (actual PostgreSQL RLS and active sessions)",
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
      // This is the isolated bare PostgreSQL harness. Managed catalog fixtures
      // have real per-user sessions; production Auth functions are applied below.
      await client.query(`
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      CREATE TABLE IF NOT EXISTS auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),not_after timestamptz,refreshed_at timestamp,user_agent text,ip inet);
      CREATE TABLE IF NOT EXISTS auth.refresh_tokens(session_id uuid);
      CREATE TABLE IF NOT EXISTS auth.mfa_factors(id uuid PRIMARY KEY,user_id uuid NOT NULL,status text NOT NULL);
      CREATE TABLE IF NOT EXISTS storage.buckets(id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE IF NOT EXISTS storage.objects(id uuid PRIMARY KEY,bucket_id text NOT NULL REFERENCES storage.buckets(id),name text NOT NULL,owner_id text,metadata jsonb,version text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),archived_at timestamptz,is_delete_marker boolean DEFAULT false,UNIQUE(bucket_id,name));
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $fn$;
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $fn$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $fn$;
      GRANT USAGE ON SCHEMA public,private,auth,storage TO authenticated,anon;
      GRANT EXECUTE ON FUNCTION auth.uid(),auth.jwt() TO authenticated,anon;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated,anon;
      REVOKE ALL ON auth.users,auth.sessions,auth.refresh_tokens,auth.mfa_factors FROM PUBLIC,anon,authenticated;
      CREATE OR REPLACE FUNCTION private.get_teams_for_authenticated_user() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
        SELECT team_id FROM public.users_on_team WHERE user_id=auth.uid()
      $fn$;
    `);
      await client.query(
        "ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY",
      );
      // Never bypass the actual active-session function with a constant true.
      await client.query(sqlFile("20261103071000_auth_session_revocation.sql"));
      await client.query(sqlFile("20261103090001_mfa_assurance.sql"));
      await client.query(
        sqlFile("20261103090002_storage_document_ingestion.sql"),
      );
      await client.query(access());
      const owner = randomUUID(),
        member = randomUUID(),
        outsider = randomUUID(),
        team = randomUUID(),
        otherTeam = randomUUID();
      const sessions: Record<string, string> = {};
      for (const user of [owner, member, outsider]) {
        sessions[user] = randomUUID();
        await client.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [
          user,
          `${user}@example.test`,
        ]);
        // A real baseline profile trigger may have handled the Auth insert.
        await client.query(
          "INSERT INTO public.users(id,email,full_name) VALUES($1,$2,'Synthetic storage actor') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,full_name=EXCLUDED.full_name",
          [user, `${user}@example.test`],
        );
        await client.query(
          "INSERT INTO auth.sessions(id,user_id,not_after,refreshed_at) VALUES($1,$2,now()+interval '1 hour',now())",
          [sessions[user], user],
        );
      }
      await client.query(
        "INSERT INTO public.teams(id,inbox_id,name) VALUES($1::uuid,$1::text,'Synthetic storage team'),($2::uuid,$2::text,'Synthetic other team')",
        [team, otherTeam],
      );
      await client.query(
        "INSERT INTO public.users_on_team(user_id,team_id,role) VALUES($1,$4,'owner'),($2,$4,'member'),($3,$5,'owner')",
        [owner, member, outsider, team, otherTeam],
      );
      return { owner, member, outsider, team, otherTeam, sessions };
    }
    async function claims(
      client: PoolClient,
      user: string,
      session: string | undefined,
      aal = "aal1",
      extra: Record<string, unknown> = {},
    ) {
      await client.query("RESET ROLE");
      await client.query("SELECT set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({
          sub: user,
          session_id: session,
          role: "authenticated",
          aal,
          ...extra,
        }),
      ]);
      await client.query("SET LOCAL ROLE authenticated");
    }
    async function put(client: PoolClient, bucket: string, path: string) {
      const id = randomUUID();
      await client.query(
        'INSERT INTO storage.objects(id,bucket_id,name,metadata,version) VALUES($1,$2,$3,\'{"size":8,"mimetype":"image/png"}\',\'v1\')',
        [id, bucket, path],
      );
      return id;
    }
    async function denied(client: PoolClient, action: () => Promise<unknown>) {
      await client.query("SAVEPOINT denied_upload");
      let error: unknown;
      try {
        await action();
      } catch (value) {
        error = value;
      }
      await client.query("ROLLBACK TO SAVEPOINT denied_upload");
      expect(error).toBeDefined();
      expect((error as { code: string }).code).toBe("42501");
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
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    }

    test("MFA-off member can upload private Vault and projection is atomic; another tenant is denied", () =>
      run(async (c, f) => {
        await claims(c, f.member, f.sessions[f.member]);
        const id = await put(c, "vault", `${f.team}/imports/synthetic.csv`);
        expect(
          (await c.query("SELECT id FROM storage.objects WHERE id=$1", [id]))
            .rowCount,
        ).toBe(1);
        await denied(c, () =>
          put(c, "vault", `${f.otherTeam}/imports/synthetic.csv`),
        );
        await c.query("RESET ROLE");
        expect(
          (
            await c.query(
              "SELECT team_id FROM public.documents WHERE object_id=$1",
              [id],
            )
          ).rows[0]?.team_id,
        ).toBe(f.team);
        await claims(c, f.outsider, f.sessions[f.outsider]);
        expect(
          (await c.query("SELECT id FROM storage.objects WHERE id=$1", [id]))
            .rowCount,
        ).toBe(0);
        expect(
          (await c.query("DELETE FROM storage.objects WHERE id=$1", [id]))
            .rowCount,
        ).toBe(0);
      }));
    test("verified MFA requires AAL2; editable metadata and stale/reassigned sessions cannot bypass", () =>
      run(async (c, f) => {
        await c.query(
          "INSERT INTO auth.mfa_factors(id,user_id,status) VALUES($1,$2,'verified')",
          [randomUUID(), f.owner],
        );
        await claims(c, f.owner, f.sessions[f.owner], "aal1", {
          user_metadata: { aal: "aal2", mfa_enabled: false },
        });
        await denied(c, () => put(c, "vault", `${f.team}/blocked.txt`));
        await claims(c, f.owner, f.sessions[f.owner], "aal2");
        await put(c, "vault", `${f.team}/allowed.txt`);
        await claims(c, f.owner, f.sessions[f.outsider], "aal2");
        await denied(c, () => put(c, "vault", `${f.team}/wrong-session.txt`));
        await claims(c, f.owner, undefined, "aal2");
        await denied(c, () => put(c, "vault", `${f.team}/missing-session.txt`));
        await c.query("RESET ROLE");
        await c.query("DELETE FROM auth.sessions WHERE id=$1", [
          f.sessions[f.owner],
        ]);
        await claims(c, f.owner, f.sessions[f.owner], "aal2");
        await denied(c, () => put(c, "vault", `${f.team}/revoked-session.txt`));
      }));
    test("deleted or banned Auth users and revoked membership stop future Storage access", () =>
      run(async (c, f) => {
        await c.query("UPDATE auth.users SET deleted_at=now() WHERE id=$1", [
          f.owner,
        ]);
        await claims(c, f.owner, f.sessions[f.owner]);
        await denied(c, () => put(c, "vault", `${f.team}/deleted.txt`));
        await c.query("RESET ROLE");
        await c.query(
          "UPDATE auth.users SET deleted_at=NULL,banned_until=now()+interval '1 day' WHERE id=$1",
          [f.owner],
        );
        await claims(c, f.owner, f.sessions[f.owner]);
        await denied(c, () => put(c, "vault", `${f.team}/banned.txt`));
        await c.query("RESET ROLE");
        await c.query("DELETE FROM public.users_on_team WHERE user_id=$1", [
          f.member,
        ]);
        await claims(c, f.member, f.sessions[f.member]);
        await denied(c, () =>
          put(c, "vault", `${f.team}/revoked-membership.txt`),
        );
      }));
    test("public images require self or team owner, fixed namespaces and immutable names", () =>
      run(async (c, f) => {
        await claims(c, f.member, f.sessions[f.member]);
        await put(c, "avatars", `users/${f.member}/${randomUUID()}.png`);
        await denied(c, () =>
          put(c, "avatars", `users/${f.owner}/${randomUUID()}.png`),
        );
        await denied(c, () =>
          put(c, "avatars", `teams/${f.team}/logo/${randomUUID()}.png`),
        );
        await denied(c, () =>
          put(c, "apps", `${f.team}/logos/${randomUUID()}.png`),
        );
        await claims(c, f.owner, f.sessions[f.owner]);
        const id = await put(
          c,
          "avatars",
          `teams/${f.team}/invoice/${randomUUID()}.jpg`,
        );
        await put(c, "apps", `${f.team}/screenshots/${randomUUID()}.webp`);
        expect(
          (
            await c.query(
              "UPDATE storage.objects SET metadata='{}' WHERE id=$1",
              [id],
            )
          ).rowCount,
        ).toBe(0);
        await denied(c, () => put(c, "apps", `logos/${randomUUID()}.png`));
        await denied(c, () =>
          put(c, "apps", `${f.team}/logos/${randomUUID()}.svg`),
        );
        await denied(c, () =>
          put(c, "apps", `${f.otherTeam}/logos/${randomUUID()}.png`),
        );
      }));
    test("traversal/percent aliases and moving private bytes into a public bucket are denied", () =>
      run(async (c, f) => {
        await claims(c, f.owner, f.sessions[f.owner]);
        for (const path of [
          `${f.team}/../escape.txt`,
          `${f.team}//empty.txt`,
          `${f.team}/%2e%2e/file`,
          `${f.team}/evil?query`,
        ])
          await denied(c, () => put(c, "vault", path));
        const id = await put(c, "vault", `${f.team}/private.csv`);
        await denied(c, () =>
          c.query(
            "UPDATE storage.objects SET bucket_id='apps',name=$2 WHERE id=$1",
            [id, `${f.team}/logos/${randomUUID()}.png`],
          ),
        );
      }));
    test("permissive legacy policies cannot override tenant, anonymous or image immutability restrictions", () =>
      run(async (c, f) => {
        await c.query(
          "CREATE POLICY synthetic_broad_policy ON storage.objects FOR ALL TO authenticated,anon USING(true) WITH CHECK(true)",
        );
        await claims(c, f.owner, f.sessions[f.owner]);
        await denied(c, () => put(c, "vault", `${f.otherTeam}/bypass.txt`));
        const id = await put(c, "apps", `${f.team}/logos/${randomUUID()}.png`);
        expect(
          (
            await c.query("UPDATE storage.objects SET name=$2 WHERE id=$1", [
              id,
              `${f.team}/logos/${randomUUID()}.png`,
            ])
          ).rowCount,
        ).toBe(0);
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE anon");
        await denied(c, () => put(c, "vault", `${f.team}/anonymous.txt`));
      }));
    test("replay keeps content/visibility; an existing private asset bucket is never made public", () =>
      run(async (c) => {
        await c.query(access());
        expect(
          (
            await c.query(
              "SELECT id,public,file_size_limit FROM storage.buckets ORDER BY id",
            )
          ).rows,
        ).toEqual([
          { id: "apps", public: true, file_size_limit: "5242880" },
          { id: "avatars", public: true, file_size_limit: "5242880" },
          { id: "vault", public: false, file_size_limit: "52428800" },
        ]);
        await c.query(
          "UPDATE storage.buckets SET public=false WHERE id='apps'",
        );
        await c.query("SAVEPOINT incompatible_bucket");
        await expect(c.query(access())).rejects.toThrow(
          "no visibility change is automatic",
        );
        await c.query("ROLLBACK TO SAVEPOINT incompatible_bucket");
        expect(
          (await c.query("SELECT public FROM storage.buckets WHERE id='apps'"))
            .rows[0].public,
        ).toBe(false);
      }));
  },
);
