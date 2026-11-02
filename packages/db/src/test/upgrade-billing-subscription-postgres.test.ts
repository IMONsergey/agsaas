import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { restoreBaselineBackendAccess } from "./helpers/baseline-backend-access";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "billing event ordering incremental migration (PostgreSQL)",
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
          "../../self-hosted/upgrades/supabase/migrations/20261101114925_billing_subscription_event_order.sql",
        ),
        "utf8",
      );
    });
    afterAll(async () => {
      await pool?.end();
    });

    test("preserves legacy paid access and cancellation without inventing a provider identity or timestamp", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await restoreBaselineBackendAccess(client, ["teams"]);
        await client.query(
          "ALTER TABLE public.teams DROP COLUMN billing_subscription_id, DROP COLUMN billing_subscription_created_at, DROP COLUMN billing_updated_at",
        );
        const teamId = randomUUID();
        await client.query(
          "INSERT INTO public.teams(id,inbox_id,name,plan,subscription_status,canceled_at) VALUES($1,$2,'Legacy subscription','pro','active','2026-10-01T12:00:00Z')",
          [teamId, teamId],
        );
        await client.query(migration);
        const row = (
          await client.query(
            "SELECT plan,subscription_status,canceled_at,billing_subscription_id,billing_subscription_created_at,billing_updated_at FROM public.teams WHERE id=$1",
            [teamId],
          )
        ).rows[0];
        expect(row).toMatchObject({
          plan: "pro",
          subscription_status: "active",
          billing_subscription_id: null,
          billing_subscription_created_at: null,
          billing_updated_at: null,
        });
        expect(new Date(row.canceled_at).toISOString()).toBe(
          "2026-10-01T12:00:00.000Z",
        );
        await client.query("SET LOCAL ROLE agsaas_app");
        await client.query(
          "UPDATE public.teams SET billing_subscription_id='verified-subscription',billing_subscription_created_at='2026-11-01T09:00:00Z',billing_updated_at='2026-11-01T10:00:00Z' WHERE id=$1",
          [teamId],
        );
        expect(
          (
            await client.query(
              "SELECT billing_subscription_id FROM public.teams WHERE id=$1",
              [teamId],
            )
          ).rows[0].billing_subscription_id,
        ).toBe("verified-subscription");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
