import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Pool, type QueryConfig } from "pg";
import { refreshAccessToken, validateAccessToken } from "../queries/oauth-flow";
import { withReplicas } from "../replicas";
import { runtimeSchema } from "../runtime-schema";
import {
  oauthAccessTokens,
  oauthApplications,
  oauthAuthorizationCodes,
} from "../schema";

function queryRecorder() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const primaryPool = new Pool({ host: "127.0.0.1", database: "query_only" });
  const replicaPool = new Pool({ host: "127.0.0.1", database: "query_only" });
  const query = async (config: string | QueryConfig, values?: unknown[]) => {
    if (typeof config === "string")
      throw new Error("Expected parameterized SQL");
    queries.push({
      sql: config.text.replace(/\s+/g, " ").trim(),
      params: values ?? config.values ?? [],
    });
    return { rows: [], fields: [], command: "SELECT", rowCount: 0, oid: 0 };
  };
  primaryPool.query = query as Pool["query"];
  replicaPool.query = (() => {
    throw new Error("OAuth authorization must not read from a replica");
  }) as Pool["query"];
  const primary = drizzle(primaryPool, {
    schema: runtimeSchema,
    casing: "snake_case",
  });
  const replica = drizzle(replicaPool, {
    schema: runtimeSchema,
    casing: "snake_case",
  });
  const db = withReplicas(primary, [replica], () => replica);
  return { db, queries };
}

function expectCurrentGrantMembership(sql: string) {
  expect(sql).toContain(
    'inner join "users_on_team" on ("users_on_team"."user_id" = "oauth_access_tokens"."user_id" and "users_on_team"."team_id" = "oauth_access_tokens"."team_id")',
  );
  expect(sql).toContain('"users"."deletion_started_at" is null');
  expect(sql).not.toContain('"oauth_applications"."created_by"');
  // Consumers need membership in their grant's team, not the developer's team.
  expect(sql).not.toContain('"oauth_applications"."team_id"');
}

describe("OAuth retained ownership and grant SQL contracts (no connections)", () => {
  test("only historical creator reference is nulled; team, client and personal grant cascades remain", () => {
    const appConfig = getTableConfig(oauthApplications);
    expect(oauthApplications.createdBy.notNull).toBe(false);
    expect(
      appConfig.foreignKeys.find(
        (fk) => fk.getName() === "oauth_applications_created_by_fkey",
      )?.onDelete,
    ).toBe("set null");
    expect(
      appConfig.foreignKeys.find(
        (fk) => fk.getName() === "oauth_applications_team_id_fkey",
      )?.onDelete,
    ).toBe("cascade");
    for (const table of [oauthAccessTokens, oauthAuthorizationCodes]) {
      const config = getTableConfig(table);
      expect(config.foreignKeys).toHaveLength(3);
      expect(config.foreignKeys.every((fk) => fk.onDelete === "cascade")).toBe(
        true,
      );
      expect(table.userId.notNull).toBe(true);
    }
  });

  test("token validation reads current grant membership on primary and keeps tokens parameterized", async () => {
    const { db, queries } = queryRecorder();
    const token = "mid_access_token_never_connect_fixture";
    expect(await validateAccessToken(db, token)).toBeNull();
    expect(queries).toHaveLength(1);
    expectCurrentGrantMembership(queries[0]!.sql);
    expect(queries[0]!.sql).not.toContain(token);
    expect(queries[0]!.params).not.toContain(token);
  });

  test("refresh reads membership and app status on primary before performing any write", async () => {
    const { db, queries } = queryRecorder();
    const refreshToken = "mid_refresh_token_never_connect_fixture";
    await expect(
      refreshAccessToken(db, {
        applicationId: "0e9a1a4a-9c7a-4ac0-b3bb-191a49a456cb",
        refreshToken,
      }),
    ).rejects.toThrow("Invalid refresh token");
    expect(queries).toHaveLength(1);
    expectCurrentGrantMembership(queries[0]!.sql);
    expect(queries[0]!.sql).toMatch(/"oauth_applications"\."active" = \$\d+/);
    expect(queries[0]!.params).not.toContain(refreshToken);
  });
});
