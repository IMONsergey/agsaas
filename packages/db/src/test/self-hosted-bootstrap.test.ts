import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  createApplicationSnapshot,
  generateBootstrapSql,
  getApplicationTableNames,
  getBaselinePath,
  readSnapshotMetadata,
} from "../../self-hosted/generate";
import { teams, userInvites, users, usersInAuth } from "../schema";

describe("self-hosted application baseline (offline)", () => {
  let sql: string;

  beforeAll(async () => {
    sql = await generateBootstrapSql();
  });

  test("matches the CLI-created migration deterministically", async () => {
    expect(getBaselinePath()).toMatch(/\/\d{14}_application_baseline\.sql$/);
    expect(readFileSync(getBaselinePath(), "utf8")).toBe(sql);
    expect(await generateBootstrapSql()).toBe(sql);
  });

  test("manages all 49 application tables and 33 enums, never platform tables", () => {
    const snapshot = createApplicationSnapshot();
    expect(Object.keys(snapshot.tables)).toHaveLength(49);
    expect(Object.keys(snapshot.enums)).toHaveLength(33);
    expect(Object.keys(snapshot.views)).toHaveLength(0);
    expect(Object.keys(snapshot.roles)).toHaveLength(0);
    for (const [key, table] of Object.entries(snapshot.tables)) {
      expect(key.startsWith("public.")).toBe(true);
      expect(table.name.includes(".")).toBe(false);
    }
    expect(sql).not.toContain('CREATE TABLE "auth".');
    expect(sql).not.toContain('CREATE TABLE "storage".');
    expect(sql).not.toContain('CREATE TABLE "auth.users"');
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION auth\./);
  });

  test("maps the real managed Auth table without generating it", () => {
    const auth = getTableConfig(usersInAuth);
    expect(auth.schema).toBe("auth");
    expect(auth.name).toBe("users");
    expect(createApplicationSnapshot().tables["auth.users"]).toBeUndefined();
  });

  test("rejects unsupported generator metadata rather than asserting unknown types", () => {
    for (const value of [null, [], {}, { tables: [] }]) {
      expect(() => readSnapshotMetadata(value)).toThrow(
        "Unsupported Drizzle snapshot metadata",
      );
    }
    expect(() =>
      readSnapshotMetadata({
        tables: {
          "public.invalid": {
            name: "invalid",
            schema: "",
            foreignKeys: {},
            policies: {},
            isRLSEnabled: false,
            columns: {
              id: {
                name: "id",
                type: "uuid",
                generated: { as: 42, type: "stored" },
              },
            },
          },
        },
        enums: {},
        views: {},
        roles: {},
      }),
    ).toThrow("Unsupported Drizzle snapshot metadata");
  });

  test("corrects the production profile FK to auth.users with delete cascade", () => {
    const key =
      createApplicationSnapshot().tables["public.users"]?.foreignKeys
        .users_id_fkey;
    expect(key).toMatchObject({
      tableFrom: "users",
      tableTo: "users",
      schemaTo: "auth",
      columnsFrom: ["id"],
      columnsTo: ["id"],
      onDelete: "cascade",
    });
    expect(sql).toContain(
      'CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade',
    );
  });

  test("does not mutate historical schema/table configuration while generating", () => {
    const before = getTableConfig(users);
    const originalPolicies = before.policies.map((policy) => policy.name);
    createApplicationSnapshot();
    const after = getTableConfig(users);
    expect(after.policies.map((policy) => policy.name)).toEqual(
      originalPolicies,
    );
    expect(after.enableRLS).toBe(before.enableRLS);
    const historicalKey = after.foreignKeys.find(
      (key) => key.getName() === "users_id_fkey",
    );
    expect(historicalKey?.reference().foreignTable).toBe(users);
  });

  test("enables RLS with an explicit non-bypassing backend policy on every table", () => {
    for (const table of Object.values(createApplicationSnapshot().tables)) {
      expect(table.isRLSEnabled).toBe(true);
      expect(Object.values(table.policies)).toEqual([
        {
          name: "agsaas_backend",
          as: "PERMISSIVE",
          for: "ALL",
          to: ["agsaas_app"],
          using: "true",
          withCheck: "true",
        },
      ]);
    }
    expect(sql.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(49);
    expect(sql).toContain("AND NOT r.rolinherit AND NOT r.rolbypassrls");
    expect(sql).toContain("m.member = r.oid");
  });

  test("revokes inherited API grants before installing explicit table CRUD", () => {
    for (const table of getApplicationTableNames()) {
      expect(sql).toContain(
        `REVOKE ALL ON TABLE public."${table}" FROM PUBLIC, anon, authenticated, service_role, agsaas_app;`,
      );
      expect(sql).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."${table}" TO agsaas_app, service_role;`,
      );
    }
    expect(sql).not.toMatch(/GRANT .*ON ALL TABLES/);
    expect(sql).not.toMatch(/GRANT .*ON (?:TABLE )?auth\./);
    expect(sql).not.toMatch(/GRANT .*ON (?:TABLE )?storage\./);
  });

  test("limits authenticated reconnect writes and denies integration credentials", () => {
    expect(sql).toContain(
      "GRANT SELECT (id, team_id), UPDATE (expires_at, reference_id) ON public.bank_connections TO authenticated;",
    );
    expect(sql).not.toContain(
      "GRANT SELECT ON public.bank_connections TO authenticated",
    );
    expect(sql).not.toContain(
      "GRANT SELECT ON public.inbox_accounts TO authenticated",
    );
    expect(sql).not.toMatch(/GRANT (?:INSERT|DELETE).* TO authenticated/);
    const mutation = readFileSync(
      join(__dirname, "../../../supabase/src/mutations/index.ts"),
      "utf8",
    );
    expect(mutation).toContain('.eq("id", id)\n    .select("id")');
  });

  test("keeps browser authorization tied to live membership and Auth subject", () => {
    expect(sql).toContain("membership.user_id = (SELECT auth.uid())");
    expect(sql).toContain(
      "user_id = (SELECT auth.uid()) AND team_id IN (SELECT private.get_teams_for_authenticated_user())",
    );
    expect(sql).not.toContain("auth.jwt() ->> 'team_id'");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION private.create_application_profile()",
    );
    expect(sql).toContain(
      "INSERT INTO public.users (id, email, full_name, avatar_url)",
    );
    expect(sql).toContain(
      "UPDATE public.users SET email = NEW.email WHERE id = NEW.id",
    );
    expect(sql).not.toContain("NEW.raw_user_meta_data ->> 'team_id'");
    expect(sql).not.toContain("NEW.raw_user_meta_data ->> 'email'");
  });

  test("guards against overwriting an existing installation before any DDL", () => {
    expect(sql.indexOf("$fresh_install$")).toBeLessThan(
      sql.indexOf("CREATE SCHEMA"),
    );
    for (const name of getApplicationTableNames()) {
      expect(sql.slice(0, sql.indexOf("$platform_prerequisites$"))).toContain(
        `'${name}'`,
      );
    }
    expect(sql).not.toMatch(/\bDROP (?:TABLE|SCHEMA|TYPE)\b/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(sql).not.toContain("00000000-0000-0000-0000-000000000000");
  });

  test("orders generated-column helpers before tables and real business functions after", () => {
    expect(
      sql.indexOf("CREATE FUNCTION public.generate_inbox_fts"),
    ).toBeLessThan(sql.indexOf('CREATE TABLE "inbox"'));
    expect(sql.indexOf('CREATE TABLE "tracker_projects"')).toBeLessThan(
      sql.indexOf("CREATE FUNCTION public.total_duration"),
    );
    expect(sql).toContain("COALESCE(sum(entry.duration), 0)");
    expect(sql).toContain("entry.team_id = project.team_id");
    expect(sql).toContain(
      "extensions.similarity(candidate.title, source.title)",
    );
    expect(sql).toContain("CREATE FUNCTION public.global_semantic_search");
  });

  test("repairs inbox aliases and pending-document FTS without changing columns", () => {
    const snapshot = createApplicationSnapshot();
    expect(snapshot.tables["public.teams"]?.columns.inbox_id?.default).toBe(
      "public.generate_inbox(10)",
    );
    expect(snapshot.tables["public.user_invites"]?.columns.code?.default).toBe(
      "public.nanoid(24)",
    );
    expect(
      snapshot.tables["public.documents"]?.columns.fts?.generated?.as,
    ).toBe(
      "to_tsvector('english'::regconfig, COALESCE(title, '') || ' ' || COALESCE(body, ''))",
    );
    expect(sql).toContain("extensions.gen_random_bytes(32)");
    expect(sql).toContain("NEW.fts_english := to_tsvector");
    expect(sql).toContain("REVOKE CREATE ON SCHEMA public");
  });

  test("real application inserts defer legacy declarative defaults to PostgreSQL", () => {
    const db = drizzle.mock({ casing: "snake_case" });
    const team = db.insert(teams).values({ name: "New team" }).toSQL();
    const invite = db
      .insert(userInvites)
      .values({ email: "invite@example.invalid" })
      .toSQL();
    expect(team.sql).toContain("default");
    expect(team.params).not.toContain("generate_inbox(10)");
    expect(team.sql).not.toContain("'generate_inbox(10)'");
    expect(invite.sql).toContain("default");
    expect(invite.params).not.toContain("nanoid(24)");
    expect(invite.sql).not.toContain("'nanoid(24)'");
  });

  test("publishes the exact current Postgres-change table contract", () => {
    expect(sql).toContain(
      "ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox, public.documents,\n  public.transactions, public.customers, public.activities, public.insights;",
    );
    expect(sql).not.toMatch(/ALTER PUBLICATION .*FOR ALL TABLES/);
  });

  test("the verifier checks Auth table privileges without requiring Auth schema usage", () => {
    const verifier = readFileSync(
      join(__dirname, "../../self-hosted/verify.sql"),
      "utf8",
    );
    expect(verifier).toContain(
      "has_table_privilege(current_user, relation.oid, 'SELECT')",
    );
    expect(verifier).toContain(
      "namespace.nspname = 'auth' AND relation.relname = 'users'",
    );
    expect(verifier).not.toContain(
      "has_table_privilege(current_user, 'auth.users'",
    );
    expect(sql).not.toMatch(/GRANT USAGE ON SCHEMA auth TO agsaas_app/);
  });
});
