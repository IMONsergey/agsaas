import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { runtimeSchema } from "../runtime-schema";

const db = drizzle.mock({ schema: runtimeSchema, casing: "snake_case" });
const userId = "45cc7538-509d-4829-959e-bba993f59a67";
const teamId = "10cf9dda-4f04-4594-8301-df14151fc2c5";

describe("application relational schema", () => {
  test("contains only the public profile table and its application relations", () => {
    const config = extractTablesRelationalConfig(
      runtimeSchema,
      createTableRelationsHelpers,
    );
    expect(config.tableNamesMap["public.users"]).toBe("users");
    expect(config.tableNamesMap["auth.users"]).toBeUndefined();
    expect(config.tables.users?.relations.usersOnTeams).toBeDefined();
    expect(config.tables.users?.relations.usersInAuth).toBeUndefined();
    expect(Object.hasOwn(runtimeSchema, "usersInAuth")).toBe(false);
    expect(Object.hasOwn(runtimeSchema, "usersInAuthRelations")).toBe(false);
  });

  test("membership query retains inferred relation types and public-profile SQL", () => {
    const query = db.query.users.findFirst({
      columns: { id: true, teamId: true },
      with: { usersOnTeams: { columns: { teamId: true } } },
    });

    // Compile-time regression: both the API middleware and its callers need
    // usersOnTeams on this inferred result, not a union with auth.users.
    const result: NonNullable<Awaited<typeof query>> = {
      id: userId,
      teamId,
      usersOnTeams: [{ teamId }],
    };
    expect(result.usersOnTeams[0]?.teamId).toBe(teamId);
    const { sql } = query.toSQL();
    expect(sql).toContain('from "users"');
    expect(sql).toContain('from "users_on_team"');
    expect(sql).not.toContain('"auth"');
    expect(sql).not.toContain("encrypted_password");
  });

  test("tracker assignees retain profile names/avatars in types and generated SQL", () => {
    const query = db.query.trackerEntries.findMany({
      columns: { id: true },
      with: {
        user: { columns: { id: true, fullName: true, avatarUrl: true } },
      },
    });
    const rows: Awaited<typeof query> = [
      {
        id: "c76a296e-d416-4b16-a49d-c2acb2333ff8",
        user: { id: userId, fullName: "Profile Name", avatarUrl: null },
      },
    ];
    expect(rows[0]?.user?.fullName).toBe("Profile Name");
    expect(rows[0]?.user?.avatarUrl).toBeNull();
    const { sql } = query.toSQL();
    expect(sql).toContain('from "users"');
    expect(sql).toContain('"full_name"');
    expect(sql).toContain('"avatar_url"');
    expect(sql).not.toContain('"auth"');
    expect(sql).not.toContain("encrypted_password");
  });

  test("every application database client shares the same managed-schema boundary", () => {
    for (const path of [
      "../client.ts",
      "../worker-client.ts",
      "../job-client.ts",
      "./helpers/test-database.ts",
    ]) {
      const source = readFileSync(join(__dirname, path), "utf8");
      expect(source).toContain("runtimeSchema as schema");
      expect(source).not.toMatch(/import \* as schema from/);
    }
  });
});
