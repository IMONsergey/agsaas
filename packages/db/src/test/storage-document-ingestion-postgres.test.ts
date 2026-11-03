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
    "../../self-hosted/upgrades/supabase/migrations/20261103090002_storage_document_ingestion.sql",
  ),
  "utf8",
);

describe.skipIf(!isTestDatabaseAvailable())(
  "Storage document ingestion (real PostgreSQL triggers)",
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
      // Storage API is not needed to test real transactional catalog projection.
      // The production columns used by the trigger are recreated only in the
      // loopback midday_test DB and rolled back after each independent test.
      await client.query(`

      CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      CREATE TABLE IF NOT EXISTS auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),not_after timestamptz,refreshed_at timestamp,user_agent text,ip inet);
      CREATE TABLE IF NOT EXISTS auth.refresh_tokens(session_id uuid);

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $fn$;
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $fn$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $fn$;
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.objects(
        id uuid PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL,
        owner_id text, metadata jsonb, version text, created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(), archived_at timestamptz, is_delete_marker boolean DEFAULT false
      );
    `);
      const team = randomUUID(),
        otherTeam = randomUUID(),
        user = randomUUID();
      const session = randomUUID();
      await client.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [
        user,
        `${user}@example.test`,
      ]);
      await client.query(
        "INSERT INTO auth.sessions(id,user_id,not_after,refreshed_at) VALUES($1,$2,now()+interval '1 hour',now())",
        [session, user],
      );
      await client.query("SELECT set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({
          sub: user,
          session_id: session,
          role: "authenticated",
          aal: "aal1",
        }),
      ]);
      await client.query(
        "INSERT INTO public.users(id,email,full_name) VALUES($1,$2,'Storage fixture')",
        [user, `${user}@example.test`],
      );
      await client.query(
        "INSERT INTO public.teams(id,inbox_id,name) VALUES($1::uuid,$1::text,'Storage fixture'),($2::uuid,$2::text,'Other storage team')",
        [team, otherTeam],
      );
      await client.query(
        "INSERT INTO public.users_on_team(user_id,team_id,role) VALUES($1,$2,'owner')",
        [user, team],
      );
      await client.query(
        "ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY",
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
      return { team, otherTeam, user };
    }
    async function put(
      client: PoolClient,
      team: string,
      user: string,
      file = "fixture.txt",
      bucket = "vault",
    ) {
      const id = randomUUID(),
        path = `${team}/${file}`;
      await client.query(
        "INSERT INTO storage.objects(id,bucket_id,name,owner_id,metadata,version) VALUES($1,$2,$3,$4,$5,'v1')",
        [
          id,
          bucket,
          path,
          user,
          { mimetype: "text/plain", size: 12, eTag: "fixture-v1" },
        ],
      );
      return { id, path };
    }
    async function doc(client: PoolClient, object: string) {
      return (
        await client.query(
          "SELECT id,name,team_id,object_id,owner_id,path_tokens,title,body,summary,processing_status,metadata FROM public.documents WHERE object_id=$1",
          [object],
        )
      ).rows[0];
    }
    async function reconcile(client: PoolClient) {
      return (
        await client.query(
          "SELECT private.reconcile_storage_documents(25) AS result",
        )
      ).rows[0].result;
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

    test("upload atomically creates owned, searchable Vault metadata before processing starts", () =>
      run(async (client, f) => {
        const o = await put(client, f.team, f.user);
        expect(await doc(client, o.id)).toMatchObject({
          name: o.path,
          team_id: f.team,
          object_id: o.id,
          owner_id: f.user,
          path_tokens: [f.team, "fixture.txt"],
          title: "fixture.txt",
          body: "",
          processing_status: "pending",
          metadata: { mimetype: "text/plain", size: 12 },
        });
        expect(
          (
            await client.query(
              "SELECT fts IS NOT NULL AS searchable FROM public.documents WHERE object_id=$1",
              [o.id],
            )
          ).rows[0].searchable,
        ).toBe(true);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM private.storage_document_projection WHERE object_id=$1",
              [o.id],
            )
          ).rows[0].n,
        ).toBe(1);
      }));

    test("replayed/duplicate events preserve identity and completed analysis", () =>
      run(async (client, f) => {
        const o = await put(client, f.team, f.user);
        const first = await doc(client, o.id);
        await client.query(
          "UPDATE public.documents SET title='Reviewed',body='kept content',summary='kept summary',processing_status='completed' WHERE id=$1",
          [first.id],
        );
        await client.query(
          "UPDATE storage.objects SET updated_at=now(),metadata=metadata WHERE id=$1",
          [o.id],
        );
        await client.query(
          "SELECT private.project_vault_object($1), private.project_vault_object($1)",
          [o.id],
        );
        expect(await doc(client, o.id)).toMatchObject({
          id: first.id,
          title: "Reviewed",
          body: "kept content",
          summary: "kept summary",
          processing_status: "completed",
        });
        expect(await reconcile(client)).toEqual({
          created: 0,
          updated: 0,
          missing: 0,
        });
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM public.documents WHERE object_id=$1",
              [o.id],
            )
          ).rows[0].n,
        ).toBe(1);
      }));

    test("lost event/legacy object is reconciled once and a missing projection row adopts existing metadata", () =>
      run(async (client, f) => {
        await client.query(
          "ALTER TABLE storage.objects DISABLE TRIGGER agsaas_storage_document_projection",
        );
        const o = await put(client, f.team, f.user);
        expect(await doc(client, o.id)).toBeUndefined();
        await client.query(
          "ALTER TABLE storage.objects ENABLE TRIGGER agsaas_storage_document_projection",
        );
        expect(await reconcile(client)).toEqual({
          created: 1,
          updated: 0,
          missing: 0,
        });
        const first = await doc(client, o.id);
        await client.query(
          "UPDATE public.documents SET title='Keep me',processing_status='completed' WHERE id=$1",
          [first.id],
        );
        await client.query(
          "DELETE FROM private.storage_document_projection WHERE object_id=$1",
          [o.id],
        );
        expect(await reconcile(client)).toEqual({
          created: 0,
          updated: 1,
          missing: 0,
        });
        expect(await doc(client, o.id)).toMatchObject({
          id: first.id,
          title: "Keep me",
          processing_status: "completed",
        });
        expect(await reconcile(client)).toEqual({
          created: 0,
          updated: 0,
          missing: 0,
        });
      }));

    test("same-team rename preserves analysis; a cross-team rename is rejected atomically", () =>
      run(async (client, f) => {
        const o = await put(client, f.team, f.user);
        const first = await doc(client, o.id);
        await client.query(
          "UPDATE public.documents SET title='Reviewed',processing_status='completed' WHERE id=$1",
          [first.id],
        );
        await client.query("UPDATE storage.objects SET name=$2 WHERE id=$1", [
          o.id,
          `${f.team}/renamed.txt`,
        ]);
        expect(await doc(client, o.id)).toMatchObject({
          id: first.id,
          name: `${f.team}/renamed.txt`,
          title: "Reviewed",
          processing_status: "completed",
        });
        await client.query("SAVEPOINT cross_team");
        await expect(
          client.query("UPDATE storage.objects SET name=$2 WHERE id=$1", [
            o.id,
            `${f.otherTeam}/stolen.txt`,
          ]),
        ).rejects.toThrow("cannot move between teams");
        await client.query("ROLLBACK TO SAVEPOINT cross_team");
        expect((await doc(client, o.id)).team_id).toBe(f.team);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM public.documents WHERE team_id=$1",
              [f.otherTeam],
            )
          ).rows[0].n,
        ).toBe(0);
      }));

    test("a new source revision clears stale content once; replay does not reset processing again", () =>
      run(async (client, f) => {
        const o = await put(client, f.team, f.user);
        await client.query(
          "UPDATE public.documents SET body='old content',summary='old summary',processing_status='completed' WHERE object_id=$1",
          [o.id],
        );
        await client.query(
          "UPDATE storage.objects SET version='v2',metadata=jsonb_set(metadata,'{eTag}','\"fixture-v2\"') WHERE id=$1",
          [o.id],
        );
        expect(await doc(client, o.id)).toMatchObject({
          body: "",
          summary: null,
          processing_status: "pending",
        });
        await client.query(
          "UPDATE public.documents SET body='new content',processing_status='completed' WHERE object_id=$1",
          [o.id],
        );
        await client.query(
          "UPDATE storage.objects SET updated_at=now() WHERE id=$1",
          [o.id],
        );
        expect(await doc(client, o.id)).toMatchObject({
          body: "new content",
          processing_status: "completed",
        });
      }));

    test("delete is transactional; a missed delete preserves metadata with an explicit missing marker", () =>
      run(async (client, f) => {
        const first = await put(client, f.team, f.user, "deleted.txt");
        await client.query("DELETE FROM storage.objects WHERE id=$1", [
          first.id,
        ]);
        expect(await doc(client, first.id)).toBeUndefined();
        const lost = await put(client, f.team, f.user, "lost-delete.txt");
        await client.query(
          "ALTER TABLE storage.objects DISABLE TRIGGER agsaas_storage_document_projection",
        );
        await client.query("DELETE FROM storage.objects WHERE id=$1", [
          lost.id,
        ]);
        await client.query(
          "ALTER TABLE storage.objects ENABLE TRIGGER agsaas_storage_document_projection",
        );
        expect(await reconcile(client)).toEqual({
          created: 0,
          updated: 0,
          missing: 1,
        });
        expect(await doc(client, lost.id)).toMatchObject({
          processing_status: "failed",
          metadata: { storageMissing: true },
        });
        expect(await reconcile(client)).toEqual({
          created: 0,
          updated: 0,
          missing: 0,
        });
      }));

    test("archive/delete markers remove the live projection and ownership changes refresh metadata", () =>
      run(async (client, f) => {
        const archived = await put(client, f.team, f.user, "archived.txt");
        await client.query(
          "UPDATE storage.objects SET archived_at=now() WHERE id=$1",
          [archived.id],
        );
        expect(await doc(client, archived.id)).toBeUndefined();
        await client.query(
          "UPDATE storage.objects SET archived_at=NULL WHERE id=$1",
          [archived.id],
        );
        expect((await doc(client, archived.id)).processing_status).toBe(
          "pending",
        );
        await client.query(
          "UPDATE storage.objects SET is_delete_marker=true WHERE id=$1",
          [archived.id],
        );
        expect(await doc(client, archived.id)).toBeUndefined();
        const owner = await put(client, f.team, f.user, "owner.txt");
        await client.query(
          "UPDATE storage.objects SET owner_id=NULL WHERE id=$1",
          [owner.id],
        );
        expect((await doc(client, owner.id)).owner_id).toBeNull();
      }));

    test("non-vault objects are ignored and malformed or unknown namespaces cannot create documents", () =>
      run(async (client, f) => {
        const avatar = await put(
          client,
          f.team,
          f.user,
          "avatar.png",
          "avatars",
        );
        expect(await doc(client, avatar.id)).toBeUndefined();
        for (const name of [
          `${f.team}/../foreign.txt`,
          `${f.team}/%2e%2e/foreign.txt`,
          `${randomUUID()}/unknown.txt`,
        ]) {
          await client.query("SAVEPOINT invalid_key");
          await expect(
            client.query(
              "INSERT INTO storage.objects(id,bucket_id,name) VALUES($1,'vault',$2)",
              [randomUUID(), name],
            ),
          ).rejects.toThrow("canonical existing team namespace");
          await client.query("ROLLBACK TO SAVEPOINT invalid_key");
        }
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM public.documents WHERE team_id=$1",
              [f.team],
            )
          ).rows[0].n,
        ).toBe(0);
      }));

    test("browser roles cannot invoke privileged reconciliation and batches are bounded", () =>
      run(async (client) => {
        expect(
          (
            await client.query(
              "SELECT has_function_privilege('authenticated','private.reconcile_storage_documents(integer)','EXECUTE') AS browser, has_function_privilege('agsaas_app','private.reconcile_storage_documents(integer)','EXECUTE') AS backend",
            )
          ).rows[0],
        ).toEqual({ browser: false, backend: true });
        await client.query("SET LOCAL ROLE agsaas_app");
        expect(await reconcile(client)).toEqual({
          created: 0,
          updated: 0,
          missing: 0,
        });
        await client.query("RESET ROLE");
        await client.query("SAVEPOINT oversized");
        await expect(
          client.query("SELECT private.reconcile_storage_documents(201)"),
        ).rejects.toThrow("between 1 and 200");
        await client.query("ROLLBACK TO SAVEPOINT oversized");
      }));
  },
);
