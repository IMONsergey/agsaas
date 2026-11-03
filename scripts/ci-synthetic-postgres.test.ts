import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFreshCatalog,
  CI_FIXTURE_ACK,
  CiFixtureFailure,
  ciConnection,
  type FreshCatalog,
  installCiFixture,
  loadCiSources,
  PG16_ROLES,
  type QueryClient,
} from "./ci-synthetic-postgres.mts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UPGRADE_DIR = "packages/db/self-hosted/upgrades/supabase/migrations";
function environment(): Record<string, string | undefined> {
  return {
    CI: "true",
    GITHUB_ACTIONS: "true",
    AGSAAS_CI_POSTGRES_FIXTURE: CI_FIXTURE_ACK,
    GITHUB_REPOSITORY: "IMONsergey/agsaas",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKSPACE: ROOT,
    TEST_DATABASE_URL:
      "postgres://postgres:synthetic-ci-only@127.0.0.1:5433/midday_test",
  };
}
function freshCatalog(): FreshCatalog {
  return {
    database: "midday_test",
    role: "postgres",
    sessionRole: "postgres",
    version: 160015,
    serverPort: 5432,
    superuser: true,
    databases: ["midday_test", "postgres", "template0", "template1"],
    schemas: ["public:pg_database_owner"],
    roles: [...PG16_ROLES],
    memberships: [
      "pg_read_all_settings:pg_monitor",
      "pg_read_all_stats:pg_monitor",
      "pg_stat_scan_tables:pg_monitor",
    ],
    unsafeRoles: 0,
    userObjects: 0,
    globalObjects: 0,
    otherClients: 0,
    extensions: ["plpgsql:pg_catalog"],
  };
}
const realIO = {
  read: (path: string) => readFileSync(join(ROOT, path), "utf8"),
  upgrades: () =>
    readdirSync(join(ROOT, UPGRADE_DIR)).filter((path) =>
      path.endsWith(".sql"),
    ),
};
const sources = loadCiSources();
const context = ciConnection(environment()).context;

describe("fresh GitHub Actions PostgreSQL boundary (no database connection)", () => {
  test("accepts only the explicit local CI destination and reports no credential", () => {
    const actual = ciConnection(environment());
    expect(actual.config.host).toBe("127.0.0.1");
    expect(actual.config.port).toBe(5433);
    expect(actual.config.database).toBe("midday_test");
    expect(actual.config.ssl).toBe(false);
    expect(JSON.stringify(actual.context)).not.toContain("synthetic-ci-only");
  });
  test("requires every positive Actions context field and the explicit ACK", () => {
    for (const field of Object.keys(environment()).filter(
      (key) => key !== "TEST_DATABASE_URL",
    ))
      expect(() =>
        ciConnection({ ...environment(), [field]: undefined }),
      ).toThrow();
    for (const patch of [
      { CI: "false" },
      { GITHUB_ACTIONS: "false" },
      { GITHUB_RUN_ID: "0" },
      { GITHUB_SHA: "not-a-sha" },
      { GITHUB_REPOSITORY: "someone/else" },
      { GITHUB_WORKSPACE: "/" },
      { AGSAAS_CI_POSTGRES_FIXTURE: "yes" },
    ])
      expect(() => ciConnection({ ...environment(), ...patch })).toThrow();
  });
  test("refuses production, existing local fixture, URL overrides and missing credentials", () => {
    for (const value of [
      undefined,
      "",
      "postgres://postgres:p@127.0.0.1:55439/midday_test",
      "postgres://postgres:p@127.0.0.1:5433/postgres",
      "postgres://postgres:p@localhost:5433/midday_test",
      "postgres://postgres:p@database.internal:5433/midday_test",
      "postgres://postgres:p@127.0.0.1:5433/midday_test?host=production",
      "postgres://postgres:p@127.0.0.1:5433/midday_test#",
      "postgres://postgres:p@127.0.0.1:5433/midday_test\n",
      "postgres://someone:p@127.0.0.1:5433/midday_test",
      "postgres://postgres@127.0.0.1:5433/midday_test",
      "postgres://postgres:%00@127.0.0.1:5433/midday_test",
    ])
      expect(() =>
        ciConnection({ ...environment(), TEST_DATABASE_URL: value }),
      ).toThrow();
  });
  test("ambient pg options and a generic database URL cannot replace explicit connection fields", () => {
    const actual = ciConnection({
      ...environment(),
      PGHOST: "production",
      PGPORT: "5432",
      PGDATABASE: "production",
      PGUSER: "admin",
      PGOPTIONS: "-c role=admin",
      PGSSLMODE: "require",
      DATABASE_URL: "postgres://production",
    });
    expect(actual.config.options).toBe(
      "-c search_path=pg_catalog -c timezone=UTC",
    );
    expect(actual.config.user).toBe("postgres");
    expect(actual.config.host).toBe("127.0.0.1");
    expect(actual.config.ssl).toBe(false);
  });
});

describe("positive empty-cluster catalog contract", () => {
  test("accepts the standard empty PostgreSQL 16 service catalog", () => {
    expect(() => assertFreshCatalog(freshCatalog())).not.toThrow();
  });
  test("refuses another version, database, role, or server port", () => {
    for (const patch of [
      { version: 150015 },
      { version: 170001 },
      { version: Number.NaN },
      { database: "production" },
      { role: "agsaas_app" },
      { sessionRole: "another_admin" },
      { serverPort: 55439 },
      { superuser: false },
    ])
      expect(() =>
        assertFreshCatalog({ ...freshCatalog(), ...patch }),
      ).toThrow();
  });
  test("refuses existing Auth, Storage, private or canonical migration schemas", () => {
    for (const name of [
      "auth",
      "storage",
      "private",
      "supabase_migrations",
      "pg_temp_1",
    ])
      expect(() =>
        assertFreshCatalog({
          ...freshCatalog(),
          schemas: ["public:pg_database_owner", `${name}:postgres`],
        }),
      ).toThrow("fresh empty");
    expect(() =>
      assertFreshCatalog({
        ...freshCatalog(),
        schemas: ["public:someone_else"],
      }),
    ).toThrow();
  });
  test("refuses any application relation, view, function or type and global objects", () => {
    for (const patch of [
      { userObjects: 1 },
      { globalObjects: 1 },
      { extensions: ["plpgsql:pg_catalog", "vector:public"] },
    ])
      expect(() => assertFreshCatalog({ ...freshCatalog(), ...patch })).toThrow(
        "fresh empty",
      );
  });
  test("refuses pre-existing policy roles, changed role attributes and memberships", () => {
    for (const name of [
      "anon",
      "authenticated",
      "service_role",
      "agsaas_app",
      "custom_admin",
    ])
      expect(() =>
        assertFreshCatalog({
          ...freshCatalog(),
          roles: [...PG16_ROLES, name].sort(),
        }),
      ).toThrow("policy roles");
    expect(() =>
      assertFreshCatalog({ ...freshCatalog(), unsafeRoles: 1 }),
    ).toThrow();
    expect(() =>
      assertFreshCatalog({ ...freshCatalog(), memberships: [] }),
    ).toThrow();
  });
  test("refuses extra databases or any other live client", () => {
    expect(() =>
      assertFreshCatalog({
        ...freshCatalog(),
        databases: [...freshCatalog().databases, "production"],
      }),
    ).toThrow();
    expect(() =>
      assertFreshCatalog({ ...freshCatalog(), otherClients: 1 }),
    ).toThrow("Another");
  });
});

describe("immutable CI SQL source set", () => {
  test("loads the actual baseline and every one of 34 ordered upgrades", () => {
    expect(sources.files).toHaveLength(35);
    expect(
      sources.files[0]!.path.endsWith(
        "20261031154237_application_baseline.sql",
      ),
    ).toBe(true);
    expect(
      sources.files
        .at(-1)!
        .path.endsWith("20261103123000_inbox_deletion_receipts.sql"),
    ).toBe(true);
    expect(
      sources.files.slice(1).map((file) => file.path.split("/").at(-1)),
    ).toEqual(realIO.upgrades().sort());
    expect(sources.receipts).toHaveLength(37);
    expect(sources.sourceSetSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  test("refuses a modified lock, baseline, upgrade or platform before connection", () => {
    for (const changed of [
      "packages/db/src/test/helpers/synthetic-foundation-source-lock.json",
      "packages/db/src/test/helpers/synthetic-platform.sql",
      sources.files[0]!.path,
      sources.files.at(-1)!.path,
    ])
      expect(() =>
        loadCiSources({
          ...realIO,
          read: (path) =>
            realIO.read(path) + (path === changed ? "\n-- drift" : ""),
        }),
      ).toThrow();
  });
  test("refuses missing or unreviewed upgrade files", () => {
    expect(() =>
      loadCiSources({ ...realIO, upgrades: () => realIO.upgrades().slice(1) }),
    ).toThrow();
    expect(() =>
      loadCiSources({
        ...realIO,
        upgrades: () => [...realIO.upgrades(), "20261104120000_unreviewed.sql"],
      }),
    ).toThrow();
  });
});

// This double exercises control flow only. It deliberately does not claim to
// parse SQL or emulate PostgreSQL; the Actions service executes the real chain.
function databaseDouble(
  options: {
    catalog?: FreshCatalog;
    lock?: boolean;
    failSql?: string;
    rollbackFails?: boolean;
    corruptCommittedReceipt?: boolean;
  } = {},
) {
  const queries: string[] = [];
  let receipt: unknown;
  const client: QueryClient = {
    async query(sql, values) {
      queries.push(sql);
      if (
        sql === options.failSql ||
        (sql === "ROLLBACK" && options.rollbackFails)
      )
        throw Object.assign(new Error("synthetic injected failure"), {
          code: "XX000",
        });
      if (sql.startsWith("SELECT jsonb_build_object("))
        return { rows: [{ catalog: options.catalog ?? freshCatalog() }] };
      if (sql.includes("pg_try_advisory_xact_lock"))
        return { rows: [{ acquired: options.lock ?? true }] };
      if (sql.startsWith("SELECT\n  NOT EXISTS("))
        return {
          rows: [
            {
              relations: true,
              extensions: true,
              profile: true,
              auth_fk: true,
              synthetic_history: true,
              exclusive: true,
            },
          ],
        };
      if (
        sql.startsWith(
          "INSERT INTO private.agsaas_synthetic_fixture_provenance",
        )
      )
        receipt = JSON.parse(String(values?.[0]));
      if (sql.startsWith("SELECT receipt FROM"))
        return {
          rows: [{ receipt: options.corruptCommittedReceipt ? {} : receipt }],
        };
      return { rows: [] };
    },
  };
  return { client, queries };
}
async function failure(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error("Expected a refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(CiFixtureFailure);
    return (error as CiFixtureFailure).receipt;
  }
}
describe("transaction protocol (fake transport, no SQL execution)", () => {
  test("locks and checks freshness before any DDL", async () => {
    const db = databaseDouble({
      catalog: { ...freshCatalog(), userObjects: 1 },
    });
    const result = await failure(installCiFixture(db.client, context, sources));
    expect(result.phase).toBe("fresh-catalog");
    expect(result.reason).toBe(
      "CI bootstrap requires a fresh empty database and cluster",
    );
    expect(db.queries.some((sql) => sql.startsWith("CREATE"))).toBe(false);
    expect(db.queries).not.toContain("COMMIT");
    expect(db.queries).toContain("ROLLBACK");
  });
  test("refuses a second bootstrap lock owner before DDL", async () => {
    const db = databaseDouble({ lock: false });
    await failure(installCiFixture(db.client, context, sources));
    expect(db.queries.some((sql) => sql.startsWith("CREATE"))).toBe(false);
    expect(db.queries).not.toContain("COMMIT");
  });
  test("sends every complete reviewed SQL file in order before the single commit", async () => {
    const db = databaseDouble();
    const result = await installCiFixture(db.client, context, sources);
    expect(result.status).toBe("committed-and-verified");
    const platformIndex = db.queries.indexOf(sources.platform);
    expect(db.queries.slice(platformIndex + 1, platformIndex + 36)).toEqual(
      sources.files.map((file) => file.sql),
    );
    expect(db.queries.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(db.queries).not.toContain("ROLLBACK");
    expect(result.sources).toEqual(sources.receipts);
    // Existing migration-chain PG test executes this legacy-refusal boundary.
    const marker = db.queries.find((sql) =>
      sql.startsWith(
        "CREATE TABLE private.agsaas_synthetic_fixture_provenance",
      ),
    )!;
    expect(marker).toContain("agsaas-ci-postgres-fixture-v1");
    expect(
      realIO.read("packages/db/src/test/helpers/setup-test-db.sql"),
    ).toContain(
      "to_regclass('private.agsaas_synthetic_fixture_provenance') IS NOT NULL",
    );
    expect(
      db.queries.some((sql) =>
        sql.startsWith("CREATE TABLE private.agsaas_baseline_installation"),
      ),
    ).toBe(false);
    expect(result.evidence).toContain("not actual Auth/Storage/Realtime/PG17");
  });
  test("a mid-chain error rolls back and verifies the original catalog", async () => {
    const db = databaseDouble({ failSql: sources.files[5]!.sql });
    const result = await failure(installCiFixture(db.client, context, sources));
    expect(result.outcome).toBe("rollback-catalog-verified");
    expect(result.reason).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("synthetic injected failure");
    expect(db.queries).toContain("ROLLBACK");
    expect(db.queries).not.toContain("COMMIT");
    expect(db.queries).not.toContain(sources.files[6]!.sql);
  });
  test("a lost COMMIT response is uncertain and never retries or reports rollback", async () => {
    const db = databaseDouble({ failSql: "COMMIT" });
    const result = await failure(installCiFixture(db.client, context, sources));
    expect(result.outcome).toBe("commit-outcome-unknown-no-retry");
    expect(db.queries.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(db.queries).not.toContain("ROLLBACK");
  });
  test("post-commit provenance failure remains committed and does not replay DDL", async () => {
    const db = databaseDouble({ corruptCommittedReceipt: true });
    const result = await failure(installCiFixture(db.client, context, sources));
    expect(result.outcome).toBe("committed-verification-failed-no-retry");
    expect(db.queries.filter((sql) => sql === sources.platform)).toHaveLength(
      1,
    );
    expect(db.queries).not.toContain("ROLLBACK");
  });
  test("failed rollback is not presented as verified", async () => {
    const db = databaseDouble({
      failSql: sources.platform,
      rollbackFails: true,
    });
    const result = await failure(installCiFixture(db.client, context, sources));
    expect(result.outcome).toBe("rollback-unconfirmed");
    expect(db.queries).not.toContain("COMMIT");
  });
});
