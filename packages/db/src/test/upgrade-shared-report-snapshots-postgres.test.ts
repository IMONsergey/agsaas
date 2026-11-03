import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "shared report incremental upgrade (isolated PostgreSQL)",
  () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
    });
    afterAll(async () => {
      await pool?.end();
    });
    test("preserves a legacy link and dates without inventing a historical snapshot", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DROP TRIGGER IF EXISTS shared_report_snapshot ON public.reports; DROP FUNCTION IF EXISTS public.guard_shared_report_snapshot(); ALTER TABLE public.reports DROP COLUMN mode CASCADE, DROP COLUMN revenue_type CASCADE, DROP COLUMN forecast_months CASCADE, DROP COLUMN chart_snapshot CASCADE, DROP COLUMN snapshot_at CASCADE, DROP COLUMN revoked_at CASCADE",
        );
        const team = randomUUID();
        const report = randomUUID();
        await client.query(
          "INSERT INTO public.teams(id,inbox_id,name) VALUES($1::uuid,$1::text,'Report upgrade fixture')",
          [team],
        );
        await client.query(
          "INSERT INTO public.reports(id,team_id,link_id,type,\"from\",\"to\",currency,expire_at) VALUES($1,$2,'legacy-fixture','revenue','2026-01-01','2026-01-31','USD','2027-01-01')",
          [report, team],
        );
        await client.query(
          readFileSync(
            join(
              __dirname,
              "../../self-hosted/upgrades/supabase/migrations/20261103062000_shared_report_snapshots.sql",
            ),
            "utf8",
          ),
        );
        const row = (
          await client.query(
            "SELECT mode,revenue_type,chart_snapshot,snapshot_at,link_id,currency,extract(year from expire_at)::int AS expiry FROM public.reports WHERE id=$1",
            [report],
          )
        ).rows[0];
        expect(row).toEqual({
          mode: "live",
          revenue_type: "net",
          chart_snapshot: null,
          snapshot_at: null,
          link_id: "legacy-fixture",
          currency: "USD",
          expiry: 2027,
        });
        await client.query("SAVEPOINT malformed");
        await expect(
          client.query(
            "UPDATE public.reports SET mode='snapshot' WHERE id=$1",
            [report],
          ),
        ).rejects.toThrow("reports_snapshot_check");
        await client.query("ROLLBACK TO SAVEPOINT malformed");
        expect(
          (
            await client.query("SELECT mode FROM public.reports WHERE id=$1", [
              report,
            ])
          ).rows[0].mode,
        ).toBe("live");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
