import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
