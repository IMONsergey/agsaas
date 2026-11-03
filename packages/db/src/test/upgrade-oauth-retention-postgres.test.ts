import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

const migrationPath = join(
  __dirname,
  "../../self-hosted/upgrades/supabase/migrations/20261101060329_preserve_team_oauth_applications.sql",
);
const definitionSql = `
  SELECT c.confdeltype AS delete_action, a.attnotnull AS not_null,
         pg_catalog.pg_get_constraintdef(c.oid) AS definition
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.conrelid = 'public.oauth_applications'::regclass
    AND c.conname = 'oauth_applications_created_by_fkey'
`;

function fixtureIds() {
  return {
    teamId: randomUUID(),
    authorId: randomUUID(),
    survivorId: randomUUID(),
    applicationId: randomUUID(),
  };
}
type Fixture = ReturnType<typeof fixtureIds>;

async function seed(client: PoolClient, f: Fixture) {
  await client.query(
    "INSERT INTO public.teams (id, name, inbox_id) VALUES ($1, 'OAuth upgrade fixture', $2)",
    [f.teamId, f.teamId],
  );
  // Seed Auth first: the baseline profile trigger may create public.users.
  await client.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data)
     VALUES ($1, $3, jsonb_build_object('full_name','OAuth upgrade author')),
            ($2, $4, jsonb_build_object('full_name','OAuth upgrade survivor'))
     ON CONFLICT (id) DO UPDATE SET
       email=excluded.email, raw_user_meta_data=excluded.raw_user_meta_data`,
    [
      f.authorId,
      f.survivorId,
      `${f.authorId}@example.test`,
      `${f.survivorId}@example.test`,
    ],
  );
  await client.query(
    `INSERT INTO public.users (id, team_id, email)
     VALUES ($1, $3, $4), ($2, $3, $5)
     ON CONFLICT (id) DO UPDATE SET
       team_id=excluded.team_id, email=excluded.email`,
    [
      f.authorId,
      f.survivorId,
      f.teamId,
      `${f.authorId}@example.test`,
      `${f.survivorId}@example.test`,
    ],
  );
  await client.query(
    `INSERT INTO public.oauth_applications
       (id, team_id, created_by, name, slug, client_id, client_secret, redirect_uris)
     VALUES ($1, $2, $3, 'Retained upgrade client', $4, $5, $6, ARRAY['https://example.test/callback'])`,
    [
      f.applicationId,
      f.teamId,
      f.authorId,
      `oauth-upgrade-${f.applicationId}`,
      `fixture-client-${f.applicationId}`,
      `fixture-secret-hash-${f.applicationId}`,
    ],
  );
  for (const userId of [f.authorId, f.survivorId]) {
    await client.query(
      `INSERT INTO public.oauth_access_tokens
         (application_id, user_id, team_id, token, refresh_token, scopes,
          expires_at, refresh_token_expires_at)
       VALUES ($1, $2, $3, $4, $5, ARRAY['invoices.read'],
               '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z')`,
      [
        f.applicationId,
        userId,
        f.teamId,
        `fixture-token-hash-${userId}`,
        `fixture-refresh-hash-${userId}`,
      ],
    );
    await client.query(
      `INSERT INTO public.oauth_authorization_codes
         (application_id, user_id, team_id, code, scopes, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, ARRAY['invoices.read'],
               'https://example.test/callback', '2099-01-01T00:00:00Z')`,
      [f.applicationId, userId, f.teamId, `fixture-code-${userId}`],
    );
  }
}

// Executes the actual SQL file against existing rows and rolls every DDL/data
// change back. Run separately from committed/concurrent PostgreSQL fixtures.
describe.skipIf(!isTestDatabaseAvailable())(
  "OAuth retention incremental upgrade (PostgreSQL rollback rehearsal)",
  () => {
    let pool: Pool;
    let migrationSql: string;
    beforeAll(() => {
      migrationSql = readFileSync(migrationPath, "utf8");
      pool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 1,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
      });
    });
    afterAll(async () => {
      await pool.end();
    });

    async function withPriorSchema(
      run: (client: PoolClient, f: Fixture) => Promise<void>,
    ) {
      const client = await pool.connect();
      const f = fixtureIds();
      try {
        const original = await client.query(definitionSql);
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL lock_timeout = '2000ms'");
          await client.query("SET LOCAL statement_timeout = '20000ms'");
          await client.query(`
            LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
            LOCK TABLE public.oauth_applications IN ACCESS EXCLUSIVE MODE;
            ALTER TABLE public.oauth_applications
              DROP CONSTRAINT oauth_applications_created_by_fkey,
              ADD CONSTRAINT oauth_applications_created_by_fkey
                FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;
          `);
          await seed(client, f);
          await run(client, f);
        } finally {
          await client.query("ROLLBACK");
          expect((await client.query(definitionSql)).rows).toEqual(
            original.rows,
          );
          const cleanup = await client.query(
            `SELECT
              (SELECT count(*)::integer FROM public.teams WHERE id = $1) AS teams,
              (SELECT count(*)::integer FROM public.users WHERE id IN ($2, $3)) AS users,
              (SELECT count(*)::integer FROM auth.users WHERE id IN ($2, $3)) AS auth_users,
              (SELECT count(*)::integer FROM public.oauth_applications WHERE id = $4) AS applications,
              (SELECT count(*)::integer FROM public.oauth_access_tokens WHERE application_id = $4) AS tokens,
              (SELECT count(*)::integer FROM public.oauth_authorization_codes WHERE application_id = $4) AS codes`,
            [f.teamId, f.authorId, f.survivorId, f.applicationId],
          );
          expect(cleanup.rows).toEqual([
            {
              teams: 0,
              users: 0,
              auth_users: 0,
              applications: 0,
              tokens: 0,
              codes: 0,
            },
          ]);
        }
      } finally {
        client.release();
      }
    }

    test("actual migration preserves existing client and surviving grants, personal grants still cascade", async () => {
      await withPriorSchema(async (client, f) => {
        const before = await client.query(
          "SELECT * FROM public.oauth_applications WHERE id = $1",
          [f.applicationId],
        );
        expect((await client.query(definitionSql)).rows[0]).toMatchObject({
          delete_action: "c",
          not_null: false,
        });
        await client.query(migrationSql);
        expect((await client.query(definitionSql)).rows[0]).toMatchObject({
          delete_action: "n",
          not_null: false,
        });
        expect(
          (
            await client.query(
              "SELECT * FROM public.oauth_applications WHERE id = $1",
              [f.applicationId],
            )
          ).rows,
        ).toEqual(before.rows);
        await client.query("DELETE FROM public.users WHERE id = $1", [
          f.authorId,
        ]);
        expect(
          (
            await client.query(
              "SELECT * FROM public.oauth_applications WHERE id = $1",
              [f.applicationId],
            )
          ).rows,
        ).toEqual([{ ...before.rows[0], created_by: null }]);
        for (const table of [
          "oauth_access_tokens",
          "oauth_authorization_codes",
        ]) {
          expect(
            (
              await client.query(
                `SELECT user_id FROM public.${table} WHERE application_id = $1`,
                [f.applicationId],
              )
            ).rows,
          ).toEqual([{ user_id: f.survivorId }]);
        }
        await client.query("DELETE FROM public.teams WHERE id = $1", [
          f.teamId,
        ]);
        expect(
          (
            await client.query(
              "SELECT id FROM public.oauth_applications WHERE id = $1",
              [f.applicationId],
            )
          ).rows,
        ).toEqual([]);
      });
    });

    test("unexpected prior delete action fails closed and transaction rolls back", async () => {
      await withPriorSchema(async (client) => {
        await client.query(`
          ALTER TABLE public.oauth_applications
            DROP CONSTRAINT oauth_applications_created_by_fkey,
            ADD CONSTRAINT oauth_applications_created_by_fkey
              FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;
        `);
        await expect(client.query(migrationSql)).rejects.toThrow(
          "Unexpected author FK definition",
        );
      });
    });

    test("reapplying the migration is rejected instead of rewriting an already upgraded FK", async () => {
      await withPriorSchema(async (client) => {
        await client.query(migrationSql);
        await expect(client.query(migrationSql)).rejects.toThrow(
          "Unexpected author FK definition",
        );
      });
    });
  },
);
