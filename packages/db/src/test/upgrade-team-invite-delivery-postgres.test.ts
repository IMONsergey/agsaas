import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "team invitation delivery incremental SQL (PostgreSQL)",
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
          "../../self-hosted/upgrades/supabase/migrations/20261101080254_durable_team_invitation_delivery.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });
    test("keeps legacy invitation data, creates no sends and denies browser roles", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DROP TABLE public.team_invite_deliveries");
        await client.query(
          "ALTER TABLE public.user_invites DROP CONSTRAINT user_invites_id_team_id_key",
        );
        const teamId = randomUUID(),
          inviteId = randomUUID();
        await client.query(
          "INSERT INTO public.teams(id,inbox_id,name) VALUES($1,$2,'Invitation migration fixture')",
          [teamId, teamId],
        );
        await client.query(
          "INSERT INTO public.user_invites(id,team_id,email,role,code) VALUES($1,$2,'legacy@example.test','member',$3)",
          [inviteId, teamId, randomUUID()],
        );
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT email,role FROM public.user_invites WHERE id=$1",
              [inviteId],
            )
          ).rows,
        ).toEqual([{ email: "legacy@example.test", role: "member" }]);
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.team_invite_deliveries",
            )
          ).rows[0].count,
        ).toBe(0);
        const {
          rows: [grants],
        } = await client.query(
          "SELECT relrowsecurity AS rls, has_table_privilege('agsaas_app','public.team_invite_deliveries','SELECT') AND has_table_privilege('agsaas_app','public.team_invite_deliveries','INSERT') AND has_table_privilege('agsaas_app','public.team_invite_deliveries','UPDATE') AND has_table_privilege('agsaas_app','public.team_invite_deliveries','DELETE') AS backend, has_table_privilege('anon','public.team_invite_deliveries','SELECT') AS anonymous, has_table_privilege('authenticated','public.team_invite_deliveries','SELECT') AS browser FROM pg_class WHERE oid='public.team_invite_deliveries'::regclass",
        );
        expect(grants).toEqual({
          rls: true,
          backend: true,
          anonymous: false,
          browser: false,
        });
        await client.query("SET LOCAL ROLE agsaas_app");
        await client.query(
          "INSERT INTO public.team_invite_deliveries(team_id,invite_id,recipient,context) VALUES($1,$2,'legacy@example.test',$3::jsonb)",
          [
            teamId,
            inviteId,
            JSON.stringify({
              invitedByName: "Owner",
              invitedByEmail: "owner@example.test",
              teamName: "Fixture",
              locale: "en",
            }),
          ],
        );
        expect(
          (
            await client.query(
              "SELECT status FROM public.team_invite_deliveries",
            )
          ).rows,
        ).toEqual([{ status: "pending" }]);
        await client.query("RESET ROLE");
        await client.query("SAVEPOINT foreign_team");
        await expect(
          client.query("UPDATE public.team_invite_deliveries SET team_id=$1", [
            randomUUID(),
          ]),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT foreign_team");
        await client.query("SAVEPOINT browser_read");
        await client.query("SET LOCAL ROLE authenticated");
        await expect(
          client.query("SELECT * FROM public.team_invite_deliveries"),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT browser_read");
        await client.query("DELETE FROM public.user_invites WHERE id=$1", [
          inviteId,
        ]);
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.team_invite_deliveries",
            )
          ).rows[0].count,
        ).toBe(0);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    test("refuses an already upgraded schema without rewriting data", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(client.query(migration)).rejects.toThrow();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(
        (
          await pool.query(
            "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='team_invite_deliveries' AND column_name='envelope_hash') AS present",
          )
        ).rows[0].present,
      ).toBe(true);
    });
  },
);
