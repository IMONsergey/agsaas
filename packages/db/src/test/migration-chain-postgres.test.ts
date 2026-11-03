import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import {
  freshInstallSql,
  migrationChain,
} from "../../../../scripts/self-hosted-migration-chain.mts";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "atomic fresh migration chain (real PostgreSQL)",
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
    const baseline =
      "CREATE TABLE private.agsaas_chain_fixture (value integer NOT NULL);";
    const commit = "a".repeat(40);
    test("legacy bare-Drizzle prerequisites refuse an installed foundation before replacing Auth helpers", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Existing foundation is retained; on a bare test harness this marker
        // exists only inside the rollback transaction for the refusal test.
        await client.query(
          "CREATE TABLE IF NOT EXISTS private.agsaas_synthetic_fixture_provenance(fixture_only boolean)",
        );
        const before = (
          await client.query(
            "SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS definition",
          )
        ).rows[0].definition;
        await client.query("SAVEPOINT legacy_setup");
        await expect(
          client.query(
            readFileSync(join(__dirname, "helpers/setup-test-db.sql"), "utf8"),
          ),
        ).rejects.toThrow(
          "Legacy Drizzle setup refuses an installed AGSaaS foundation",
        );
        await client.query("ROLLBACK TO SAVEPOINT legacy_setup");
        expect(
          (
            await client.query(
              "SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS definition",
            )
          ).rows[0].definition,
        ).toBe(before);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    test("complete chain and migration history commit together; rollback verification leaves neither", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const chain = migrationChain([
          {
            filename: "20261103060000_one.sql",
            sql: "INSERT INTO private.agsaas_chain_fixture VALUES(1);",
          },
          {
            filename: "20261103061000_two.sql",
            sql: "UPDATE private.agsaas_chain_fixture SET value=2;",
          },
        ]);
        await client.query(
          freshInstallSql("SELECT 1;", baseline, commit, chain),
        );
        expect(
          (await client.query("SELECT value FROM private.agsaas_chain_fixture"))
            .rows,
        ).toEqual([{ value: 2 }]);
        expect(
          (
            await client.query(
              "SELECT count(*)::int n FROM supabase_migrations.schema_migrations",
            )
          ).rows[0].n,
        ).toBe(3);
        await client.query("ROLLBACK");
        expect(
          (
            await client.query(
              "SELECT to_regclass('private.agsaas_chain_fixture') AS relation",
            )
          ).rows[0].relation,
        ).toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    test("failure in the final upgrade rolls back baseline and all earlier changes", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const chain = migrationChain([
          {
            filename: "20261103060000_one.sql",
            sql: "INSERT INTO private.agsaas_chain_fixture VALUES(1);",
          },
          {
            filename: "20261103061000_two.sql",
            sql: "INSERT INTO private.agsaas_chain_fixture VALUES(NULL);",
          },
        ]);
        await expect(
          client.query(freshInstallSql("SELECT 1;", baseline, commit, chain)),
        ).rejects.toThrow("null");
        await client.query("ROLLBACK");
        expect(
          (
            await client.query(
              "SELECT to_regclass('private.agsaas_chain_fixture') AS relation",
            )
          ).rows[0].relation,
        ).toBeNull();
        expect(
          (
            await client.query(
              "SELECT to_regclass('private.agsaas_baseline_installation') AS relation",
            )
          ).rows[0].relation,
        ).toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
