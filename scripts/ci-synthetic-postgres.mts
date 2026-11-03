/**
 * Fresh GitHub Actions PG16 fixture only. This does not install Supabase Auth,
 * Storage, Realtime, PostgreSQL 17 or canonical migration history. Never run it
 * against the preserved local fixture. Existing databases are refused, not reset.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, type ClientConfig } from "pg";
import { getTestDatabaseUrl } from "../packages/db/src/test/helpers/test-database-config.ts";
import { migrationChain } from "./self-hosted-migration-chain.mts";
import { upgradeStatements } from "./self-hosted-rehearsal.mts";

export const CI_FIXTURE_ACK = "fresh-github-actions-pg16-midday-test";
export const CI_FIXTURE_KIND = "agsaas-ci-postgres-fixture-v1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCK =
  "packages/db/src/test/helpers/synthetic-foundation-source-lock.json";
const PLATFORM = "packages/db/src/test/helpers/synthetic-platform.sql";
const BASELINE =
  "packages/db/self-hosted/supabase/migrations/20261031154237_application_baseline.sql";
const UPGRADES = "packages/db/self-hosted/upgrades/supabase/migrations";
const LOCK_SHA256 =
  "b21fcb082c2101c2cdb44d7fceba2ab3b51de66bf3128e6ca9df23726a5a6cf3";
const PLATFORM_SHA256 =
  "fa3c37cb6846667cd91f54d3d460577377300bab7c61b2da3798880cacfbedd5";
const PROVISION = [
  "CREATE ROLE anon NOLOGIN;",
  "CREATE ROLE authenticated NOLOGIN;",
  "CREATE ROLE service_role NOLOGIN;",
  "CREATE ROLE agsaas_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;",
].join("\n");

type Row = Record<string, unknown>;
export interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
export class CiFixtureRefusal extends Error {}
export class CiFixtureFailure extends Error {
  constructor(
    readonly receipt: {
      phase: string;
      outcome: string;
      sqlState: string | null;
      reason?: string;
    },
  ) {
    super(JSON.stringify(receipt));
  }
}
function requireFixture(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new CiFixtureRefusal(message);
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}

export function ciConnection(
  env: Record<string, string | undefined> = process.env,
): { config: ClientConfig; context: Record<string, string> } {
  requireFixture(
    env.CI === "true" &&
      env.GITHUB_ACTIONS === "true" &&
      env.AGSAAS_CI_POSTGRES_FIXTURE === CI_FIXTURE_ACK &&
      env.GITHUB_REPOSITORY === "IMONsergey/agsaas" &&
      /^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") &&
      /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") &&
      env.GITHUB_WORKSPACE &&
      resolve(env.GITHUB_WORKSPACE) === resolve(ROOT),
    "Explicit AGSaaS GitHub Actions fixture context is required",
  );
  // The shared parser rejects query-string option overrides, fragments and
  // control characters. No DATABASE_URL or ambient pg connection defaults.
  requireFixture(
    typeof env.TEST_DATABASE_URL === "string" &&
      env.TEST_DATABASE_URL.length > 0,
    "Explicit CI TEST_DATABASE_URL is required",
  );
  let parsed: URL;
  try {
    parsed = new URL(getTestDatabaseUrl(env.TEST_DATABASE_URL));
  } catch {
    throw new CiFixtureRefusal("Explicit CI TEST_DATABASE_URL is unsafe");
  }
  requireFixture(
    parsed.hostname === "127.0.0.1" &&
      parsed.port === "5433" &&
      parsed.pathname === "/midday_test" &&
      parsed.username === "postgres" &&
      parsed.password.length > 0,
    "Only postgres at the fresh loopback CI service on port 5433 is permitted",
  );
  let password: string;
  try {
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new CiFixtureRefusal("Malformed CI database credential");
  }
  requireFixture(
    password.length > 0 &&
      ![...password].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      }),
    "Malformed CI database credential",
  );
  return {
    config: {
      host: "127.0.0.1",
      port: 5433,
      database: "midday_test",
      user: "postgres",
      password,
      ssl: false,
      application_name: "agsaas-fresh-ci-postgres",
      options: "-c search_path=pg_catalog -c timezone=UTC",
      connectionTimeoutMillis: 5000,
      statement_timeout: 45000,
      query_timeout: 50000,
    },
    context: {
      repository: env.GITHUB_REPOSITORY!,
      runId: env.GITHUB_RUN_ID!,
      runAttempt: env.GITHUB_RUN_ATTEMPT!,
      workflowSha: env.GITHUB_SHA!,
    },
  };
}

type Source = { path: string; sha256: string; sql: string };
type SourceIO = { read(path: string): string; upgrades(): string[] };
const localSourceIO: SourceIO = {
  read(path) {
    const filename = join(ROOT, path);
    requireFixture(
      lstatSync(filename).isFile() &&
        realpathSync(filename) === resolve(filename),
      "SQL sources must be regular repository files",
    );
    return readFileSync(filename, "utf8");
  },
  upgrades: () =>
    readdirSync(join(ROOT, UPGRADES)).filter((x) => x.endsWith(".sql")),
};
export function loadCiSources(io: SourceIO = localSourceIO) {
  const lockText = io.read(LOCK);
  requireFixture(digest(lockText) === LOCK_SHA256, "Reviewed SQL lock differs");
  const lock = JSON.parse(lockText) as {
    kind: string;
    files: { path: string; sha256: string }[];
  };
  requireFixture(
    lock.kind === "agsaas-synthetic-foundation-source-lock-v1" &&
      lock.files.length === 35 &&
      lock.files[0]?.path === BASELINE &&
      new Set(lock.files.map((file) => file.path)).size === 35 &&
      canonical(lock.files.slice(1).map((file) => file.path)) ===
        canonical(
          io
            .upgrades()
            .sort()
            .map((file) => `${UPGRADES}/${file}`),
        ),
    "The exact baseline and 34 ordered upgrades are required",
  );
  const files: Source[] = lock.files.map((file) => {
    requireFixture(
      file.path === BASELINE ||
        /^packages\/db\/self-hosted\/upgrades\/supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/.test(
          file.path,
        ),
      "Unexpected application SQL path",
    );
    const sql = io.read(file.path);
    requireFixture(
      digest(sql) === file.sha256,
      "Immutable application SQL differs",
    );
    upgradeStatements(sql);
    return { ...file, sql };
  });
  migrationChain(
    files.slice(1).map((file) => ({
      filename: file.path.split("/").at(-1)!,
      sql: file.sql,
    })),
  );
  const platform = io.read(PLATFORM);
  requireFixture(
    digest(platform) === PLATFORM_SHA256,
    "Synthetic platform differs",
  );
  upgradeStatements(platform);
  const receipts = [
    { path: "ci-policy-roles", sha256: digest(PROVISION) },
    { path: PLATFORM, sha256: PLATFORM_SHA256 },
    ...files.map(({ path, sha256 }) => ({ path, sha256 })),
  ];
  return {
    files,
    platform,
    receipts,
    lockSha256: LOCK_SHA256,
    sourceSetSha256: digest(canonical({ lockSha256: LOCK_SHA256, receipts })),
  };
}

// PostgreSQL 16 predefined roles: https://www.postgresql.org/docs/16/predefined-roles.html
export const PG16_ROLES = [
  "pg_checkpoint",
  "pg_create_subscription",
  "pg_database_owner",
  "pg_execute_server_program",
  "pg_monitor",
  "pg_read_all_data",
  "pg_read_all_settings",
  "pg_read_all_stats",
  "pg_read_server_files",
  "pg_signal_backend",
  "pg_stat_scan_tables",
  "pg_use_reserved_connections",
  "pg_write_all_data",
  "pg_write_server_files",
  "postgres",
].sort();
const MEMBERSHIPS = [
  "pg_read_all_settings:pg_monitor",
  "pg_read_all_stats:pg_monitor",
  "pg_stat_scan_tables:pg_monitor",
];
export type FreshCatalog = {
  database: string;
  role: string;
  sessionRole: string;
  version: number;
  serverPort: number;
  superuser: boolean;
  databases: string[];
  schemas: string[];
  roles: string[];
  memberships: string[];
  unsafeRoles: number;
  userObjects: number;
  globalObjects: number;
  otherClients: number;
  extensions: string[];
};
const FRESH_CATALOG_SQL = `SELECT jsonb_build_object(
  'database',current_database(),'role',current_user,'sessionRole',session_user,
  'version',current_setting('server_version_num')::int,
  'serverPort',current_setting('port')::int,
  'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
  'databases',(SELECT jsonb_agg(datname ORDER BY datname COLLATE "C") FROM pg_database),
  'schemas',(SELECT jsonb_agg(nspname || ':' || pg_get_userbyid(nspowner) ORDER BY nspname COLLATE "C")
    FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','pg_toast','information_schema')),
  'roles',(SELECT jsonb_agg(rolname ORDER BY rolname COLLATE "C") FROM pg_roles),
  'memberships',(SELECT jsonb_agg(r.rolname || ':' || m.rolname ORDER BY r.rolname COLLATE "C",m.rolname COLLATE "C")
    FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member),
  'unsafeRoles',(SELECT count(*) FROM pg_roles WHERE rolconfig IS NOT NULL OR NOT rolinherit OR rolconnlimit<>-1 OR rolvaliduntil IS NOT NULL OR
    (rolname='postgres' AND NOT (rolcanlogin AND rolsuper AND rolcreatedb AND rolcreaterole AND rolreplication AND rolbypassrls)) OR
    (rolname<>'postgres' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))) +
    (SELECT count(*) FROM pg_auth_members WHERE admin_option OR NOT inherit_option OR NOT set_option),
  'userObjects',(SELECT count(*) FROM (
    SELECT relnamespace AS namespace FROM pg_class UNION ALL
    SELECT pronamespace FROM pg_proc UNION ALL SELECT typnamespace FROM pg_type UNION ALL
    SELECT oprnamespace FROM pg_operator UNION ALL SELECT collnamespace FROM pg_collation UNION ALL
    SELECT connamespace FROM pg_conversion UNION ALL SELECT cfgnamespace FROM pg_ts_config UNION ALL
    SELECT dictnamespace FROM pg_ts_dict UNION ALL SELECT prsnamespace FROM pg_ts_parser UNION ALL
    SELECT tmplnamespace FROM pg_ts_template
    ) objects JOIN pg_namespace n ON n.oid=objects.namespace
    WHERE n.nspname NOT IN ('pg_catalog','pg_toast','information_schema')),
  'globalObjects',(SELECT count(*) FROM pg_publication) + (SELECT count(*) FROM pg_subscription) +
    (SELECT count(*) FROM pg_event_trigger) + (SELECT count(*) FROM pg_foreign_server) +
    (SELECT count(*) FROM pg_foreign_data_wrapper) + (SELECT count(*) FROM pg_largeobject_metadata) +
    (SELECT count(*) FROM pg_default_acl) + (SELECT count(*) FROM pg_db_role_setting) +
    (SELECT count(*) FROM pg_replication_slots) + (SELECT count(*) FROM pg_transform) +
    (SELECT count(*) FROM pg_cast WHERE oid>=16384) +
    (SELECT count(*) FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql')),
  'otherClients',(SELECT count(*) FROM pg_stat_activity
    WHERE backend_type='client backend' AND pid<>pg_backend_pid()),
  'extensions',(SELECT jsonb_agg(e.extname || ':' || n.nspname ORDER BY e.extname COLLATE "C")
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace)
) AS catalog`;
export async function readFreshCatalog(
  client: QueryClient,
): Promise<FreshCatalog> {
  const result = await client.query(FRESH_CATALOG_SQL);
  return result.rows[0]?.catalog as FreshCatalog;
}
export function assertFreshCatalog(catalog: FreshCatalog) {
  requireFixture(
    catalog &&
      catalog.database === "midday_test" &&
      catalog.role === "postgres" &&
      catalog.sessionRole === "postgres" &&
      Number.isInteger(catalog.version) &&
      catalog.version >= 160000 &&
      catalog.version < 170000 &&
      catalog.serverPort === 5432 &&
      catalog.superuser === true,
    "Expected the isolated PostgreSQL 16 CI service identity",
  );
  requireFixture(
    canonical(catalog.databases) ===
      canonical(["midday_test", "postgres", "template0", "template1"]) &&
      canonical(catalog.schemas) === canonical(["public:pg_database_owner"]) &&
      canonical(catalog.extensions) === canonical(["plpgsql:pg_catalog"]) &&
      catalog.userObjects === 0 &&
      catalog.globalObjects === 0,
    "CI bootstrap requires a fresh empty database and cluster",
  );
  requireFixture(
    canonical(catalog.roles) === canonical(PG16_ROLES) &&
      canonical(catalog.memberships) === canonical(MEMBERSHIPS) &&
      catalog.unsafeRoles === 0,
    "CI policy roles must not exist and predefined roles must be unmodified",
  );
  requireFixture(
    catalog.otherClients === 0,
    "Another database client is present",
  );
}

const REQUIRED_RELATIONS = [
  "auth.users",
  "auth.sessions",
  "auth.mfa_factors",
  "storage.objects",
  "storage.buckets",
  "public.teams",
  "public.users",
  "public.export_snapshots",
  "public.invoice_refund_requests",
  "public.hosted_bank_consents",
  "private.inbox_deletion_receipts",
  "private.bank_sync_operations",
  "private.onboarding_deliveries",
];
const VERIFY_SQL = `SELECT
  NOT EXISTS(SELECT 1 FROM unnest($1::text[]) name WHERE to_regclass(name) IS NULL) AS relations,
  (SELECT count(*)=3 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname IN ('vector','pg_trgm','pgcrypto') AND n.nspname='extensions') AS extensions,
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='auth.users'::regclass
    AND tgname='agsaas_auth_user_created' AND tgenabled='O') AS profile,
  EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.users'::regclass
    AND confrelid='auth.users'::regclass AND contype='f' AND convalidated) AS auth_fk,
  to_regnamespace('supabase_migrations') IS NULL AS synthetic_history,
  NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE backend_type='client backend'
    AND pid<>pg_backend_pid()) AS exclusive`;
export async function installCiFixture(
  client: QueryClient,
  context: Record<string, string>,
  sources = loadCiSources(),
) {
  let phase = "begin";
  let opened = false;
  let commitSent = false;
  let committed = false;
  let before: FreshCatalog | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    opened = true;
    await client.query(
      "SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='1500ms'; SET LOCAL statement_timeout='45s'; SET LOCAL idle_in_transaction_session_timeout='60s'",
    );
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(1095193409,20261104) AS acquired",
    );
    requireFixture(
      lock.rows[0]?.acquired === true,
      "Another CI bootstrap owns the fixture lock",
    );
    phase = "fresh-catalog";
    before = await readFreshCatalog(client);
    assertFreshCatalog(before);
    phase = "policy-roles";
    await client.query(PROVISION);
    phase = PLATFORM;
    await client.query(sources.platform);
    for (const file of sources.files) {
      phase = file.path;
      // Whole immutable SQL bytes: no rewriting guards or selecting DDL tails.
      await client.query(file.sql);
    }
    phase = "postconditions";
    const verified = (await client.query(VERIFY_SQL, [REQUIRED_RELATIONS]))
      .rows[0];
    requireFixture(
      verified &&
        [
          "relations",
          "extensions",
          "profile",
          "auth_fk",
          "synthetic_history",
          "exclusive",
        ].every((key) => verified[key] === true),
      "Native application chain postconditions failed",
    );
    const receipt = {
      kind: CI_FIXTURE_KIND,
      evidence:
        "Synthetic application SQL on fresh PG16; not actual Auth/Storage/Realtime/PG17 or canonical migration history",
      context,
      database: "midday_test",
      serverVersion: before.version,
      catalogBeforeSha256: digest(canonical(before)),
      lockSha256: sources.lockSha256,
      sourceSetSha256: sources.sourceSetSha256,
      helperSha256: digest(
        readFileSync(fileURLToPath(import.meta.url), "utf8"),
      ),
      sources: sources.receipts,
    };
    // The shared marker makes legacy Drizzle preparation refuse this fixture.
    // Its distinct CI kind does not impersonate the preserved local foundation.
    phase = "private-provenance";
    await client.query(
      "CREATE TABLE private.agsaas_synthetic_fixture_provenance (singleton boolean PRIMARY KEY CHECK(singleton), fixture_kind text NOT NULL CHECK(fixture_kind='agsaas-ci-postgres-fixture-v1'), receipt jsonb NOT NULL CHECK((receipt->>'kind'=fixture_kind) IS TRUE)); REVOKE ALL ON private.agsaas_synthetic_fixture_provenance FROM PUBLIC,anon,authenticated,agsaas_app,service_role",
    );
    await client.query(
      "INSERT INTO private.agsaas_synthetic_fixture_provenance VALUES(true,'agsaas-ci-postgres-fixture-v1',$1::jsonb)",
      [JSON.stringify(receipt)],
    );
    phase = "commit";
    commitSent = true;
    await client.query("COMMIT");
    opened = false;
    committed = true;
    phase = "committed-provenance";
    const stored = await client.query(
      "SELECT receipt FROM private.agsaas_synthetic_fixture_provenance WHERE singleton",
    );
    requireFixture(
      canonical(stored.rows[0]?.receipt) === canonical(receipt),
      "Committed CI provenance differs",
    );
    return { status: "committed-and-verified", ...receipt };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : null;
    const sqlState =
      typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : null;
    if (commitSent) {
      throw new CiFixtureFailure({
        phase,
        outcome: committed
          ? "committed-verification-failed-no-retry"
          : "commit-outcome-unknown-no-retry",
        sqlState,
        ...(error instanceof CiFixtureRefusal ? { reason: error.message } : {}),
      });
    }
    let outcome = opened ? "rollback-unconfirmed" : "transaction-not-started";
    if (opened) {
      try {
        await client.query("ROLLBACK");
        outcome = "rollback-acknowledged";
        if (
          before &&
          canonical(await readFreshCatalog(client)) === canonical(before)
        )
          outcome = "rollback-catalog-verified";
      } catch {
        /* Do not claim a rollback proof from a closed connection. */
      }
    }
    throw new CiFixtureFailure({
      phase,
      outcome,
      sqlState,
      ...(error instanceof CiFixtureRefusal ? { reason: error.message } : {}),
    });
  }
}

async function main() {
  requireFixture(
    process.argv.length === 2,
    "CI bootstrap takes no command-line arguments",
  );
  const { config, context } = ciConnection();
  const sources = loadCiSources(); // All pins validated before a connection exists.
  const client = new Client(config);
  try {
    await client.connect();
    console.log(
      JSON.stringify(await installCiFixture(client, context, sources), null, 2),
    );
  } finally {
    await client.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "failed",
        ...(error instanceof CiFixtureFailure
          ? error.receipt
          : {
              reason:
                error instanceof CiFixtureRefusal
                  ? error.message
                  : "CI fixture failed; private details suppressed",
            }),
      }),
    );
    process.exitCode = 1;
  });
}
