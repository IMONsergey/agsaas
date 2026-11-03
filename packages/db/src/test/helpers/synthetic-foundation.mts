import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { migrationChain } from "../../../../../scripts/self-hosted-migration-chain.mts";
import { upgradeStatements } from "../../../../../scripts/self-hosted-rehearsal.mts";
import {
  getTestDatabaseUrl,
  TestDatabaseConfigurationError,
} from "./test-database-config.ts";

// This intentionally is not a portable database installer. A new instance or
// catalog requires another review; it must never discover a production target.
export const FIXTURE_KIND = "agsaas-synthetic-foundation-v1";
export const FIXTURE_SYSTEM_ID = "7703819082990792743";
export const WRITE_ACK =
  "preserve-old-schemas-and-create-synthetic-auth-storage-fixture-only";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");
const UPGRADE_DIRECTORY =
  "packages/db/self-hosted/upgrades/supabase/migrations";
const SCHEMAS = ["public", "private", "auth"] as const;
const EVIDENCE = {
  label: "Synthetic PostgreSQL 16 application SQL fixture",
  actualAuthService: false,
  actualStorageService: false,
  actualRealtimeService: false,
  postgresql17Acceptance: false,
  canonicalMigrationHistory: false,
};

class FixtureRefusal extends Error {}

type Row = Record<string, unknown>;
export type Catalog = Record<string, Row[]>;
type SourceFile = { path: string; sha256: string; sql: string };
type Sources = {
  files: SourceFile[];
  platform: string;
  sha256: string;
  receipts: { path: string; sha256: string }[];
};
export type Approval = {
  kind: typeof FIXTURE_KIND;
  mode: "rehearse" | "commit";
  operationId: string;
  database: "midday_test";
  port: 55439;
  systemId: typeof FIXTURE_SYSTEM_ID;
  catalogSha256: string;
  sourceSetSha256: string;
  acknowledgement: typeof WRITE_ACK;
  preserveOldSchemas: true;
  allowRelocatableExtensions: true;
  acceptSyntheticPlatformOnly: true;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new FixtureRefusal("Unserializable catalog value");
  return encoded;
}

export function fixtureUrl(value = process.env.TEST_DATABASE_URL): string {
  const result = getTestDatabaseUrl(value);
  const url = new URL(result);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.port !== "55439"
  ) {
    throw new FixtureRefusal(
      "Foundation requires the reviewed loopback fixture port",
    );
  }
  return result;
}

export function queueUnit(cgroup: string): string {
  const match = cgroup.match(/(?:^|\/)(imon-job@[^/\n]+\.service)(?:\/|$)/m);
  if (!match)
    throw new FixtureRefusal(
      "Foundation writes require the shared imon-job queue",
    );
  return match[1]!;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function archiveNames(operationId: string): Record<string, string> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      operationId,
    )
  ) {
    throw new FixtureRefusal(
      "A reviewed UUIDv4 operation identity is required",
    );
  }
  const token = operationId.replaceAll("-", "");
  return Object.fromEntries(
    SCHEMAS.map((name) => [name, `agsaas_fixture_${token}_${name}`]),
  );
}

export function validateApproval(
  value: unknown,
  mode: Approval["mode"],
  catalogSha256: string,
  sourceSetSha256: string,
): Approval {
  const a = value as Partial<Approval> | null;
  if (
    !a ||
    a.kind !== FIXTURE_KIND ||
    a.mode !== mode ||
    a.database !== "midday_test" ||
    a.port !== 55439 ||
    a.systemId !== FIXTURE_SYSTEM_ID ||
    a.catalogSha256 !== catalogSha256 ||
    a.sourceSetSha256 !== sourceSetSha256 ||
    !/^[a-f0-9]{64}$/.test(a.catalogSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(a.sourceSetSha256 ?? "") ||
    a.acknowledgement !== WRITE_ACK ||
    a.preserveOldSchemas !== true ||
    a.allowRelocatableExtensions !== true ||
    a.acceptSyntheticPlatformOnly !== true
  )
    throw new FixtureRefusal(
      "Explicit fixture approval or reviewed fingerprints differ",
    );
  archiveNames(a.operationId ?? "");
  return a as Approval;
}

function readApproval(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 32768
    ) {
      throw new FixtureRefusal(
        "Approval must be an owned regular mode-0600 file",
      );
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

export function loadSources(root = ROOT): Sources {
  const lockText = readFileSync(
    join(HERE, "synthetic-foundation-source-lock.json"),
    "utf8",
  );
  const lock = JSON.parse(lockText) as {
    kind: string;
    files: { path: string; sha256: string }[];
  };
  if (
    lock.kind !== "agsaas-synthetic-foundation-source-lock-v1" ||
    lock.files.length !== 32
  ) {
    throw new FixtureRefusal("Unexpected reviewed application SQL source lock");
  }
  const paths = lock.files.map((file) => file.path);
  const baseline =
    "packages/db/self-hosted/supabase/migrations/20261031154237_application_baseline.sql";
  const actual = readdirSync(join(root, UPGRADE_DIRECTORY))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (
    paths[0] !== baseline ||
    new Set(paths).size !== paths.length ||
    canonical(paths.slice(1)) !==
      canonical(actual.map((name) => `${UPGRADE_DIRECTORY}/${name}`))
  ) {
    throw new FixtureRefusal(
      "Missing, additional or reordered application migration sources",
    );
  }
  const files = lock.files.map((file) => {
    if (
      file.path !== baseline &&
      !/^packages\/db\/self-hosted\/upgrades\/supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/.test(
        file.path,
      )
    ) {
      throw new FixtureRefusal("Unexpected SQL source path");
    }
    const sql = readFileSync(join(root, file.path), "utf8");
    if (sha256(sql) !== file.sha256)
      throw new FixtureRefusal("Reviewed immutable SQL bytes differ");
    return { ...file, sql };
  });
  // Reuse the application's SQL-aware transaction-control guard and ordering.
  upgradeStatements(files[0]!.sql);
  migrationChain(
    files.slice(1).map((file) => ({
      filename: file.path.split("/").at(-1)!,
      sql: file.sql,
    })),
  );
  const platform = readFileSync(join(HERE, "synthetic-platform.sql"), "utf8");
  upgradeStatements(platform);
  const receipts = [
    { path: "synthetic-platform.sql", sha256: sha256(platform) },
    ...files.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
  ];
  return {
    files,
    platform,
    receipts,
    sha256: sha256(
      canonical({
        receipts,
        lockSha256: sha256(lockText),
        helperSha256: sha256(
          readFileSync(fileURLToPath(import.meta.url), "utf8"),
        ),
      }),
    ),
  };
}

// No application row contents, passwords or connection strings enter this
// catalog. Routine bodies are hashed in memory before creating a fingerprint.
const CATALOG_SQL: Record<string, string> = {
  identity: `SELECT current_database() AS database,current_user AS role,
    current_setting('server_version_num') AS version,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_id,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid`,
  databases:
    "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
  schemas: `SELECT oid::text,nspname,pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl
    FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' ORDER BY nspname`,
  relations: `SELECT c.oid::text,n.oid::text AS namespace,n.nspname AS schema,c.relname AS name,
    c.relkind AS kind,c.relfilenode::text AS filenode,c.relowner::text AS owner,
    c.relacl::text AS acl,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private','auth','storage','extensions') ORDER BY n.nspname,c.relname`,
  columns: `SELECT a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,
    a.attidentity,a.attgenerated,a.attacl::text,pg_get_expr(d.adbin,d.adrelid) AS expression
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname IN ('public','private','auth','storage','extensions') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY a.attrelid,a.attnum`,
  constraints: `SELECT c.oid::text,c.conrelid::text,c.confrelid::text,c.conname,c.contype,c.convalidated,
    pg_get_constraintdef(c.oid,true) AS definition FROM pg_constraint c
    JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname IN ('public','private','auth','storage','extensions') ORDER BY c.oid`,
  routines: `SELECT p.oid::text,n.nspname AS schema,p.proname AS name,
    pg_get_function_identity_arguments(p.oid) AS args,p.proowner::text AS owner,p.proacl::text AS acl,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','private','auth','storage','extensions') AND p.prokind<>'a' ORDER BY p.oid`,
  triggers: `SELECT t.oid::text,t.tgrelid::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private','auth','storage','extensions') AND NOT t.tgisinternal ORDER BY t.oid`,
  policies: `SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
    FROM pg_policies WHERE schemaname IN ('public','private','auth','storage','extensions') ORDER BY schemaname,tablename,policyname`,
  indexes: `SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname IN ('public','private','auth','storage','extensions') ORDER BY schemaname,tablename,indexname`,
  enums: `SELECT t.oid::text,n.nspname,t.typname,e.enumsortorder,e.enumlabel FROM pg_type t
    JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname IN ('public','private','auth','storage','extensions') ORDER BY t.oid,e.enumsortorder`,
  extensions: `SELECT e.oid::text,e.extname,e.extversion,e.extrelocatable,n.nspname AS schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname`,
  availableExtensions: `SELECT name,default_version,installed_version FROM pg_available_extensions
    WHERE name IN ('vector','pg_trgm','pgcrypto') ORDER BY name`,
  roles: `SELECT oid::text,rolname,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,
    rolreplication,rolcanlogin,rolconfig FROM pg_roles
    WHERE rolname IN ('agsaas_app','anon','authenticated','service_role') ORDER BY rolname`,
  memberships: `SELECT m.roleid::text,m.member::text,m.admin_option FROM pg_auth_members m
    JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('agsaas_app','anon','authenticated','service_role') ORDER BY m.roleid,m.member`,
  publications:
    "SELECT pubname,puballtables,pubinsert,pubupdate,pubdelete,pubtruncate FROM pg_publication ORDER BY pubname",
  publicationTables:
    "SELECT pubname,schemaname,tablename FROM pg_publication_tables ORDER BY pubname,schemaname,tablename",
  eventTriggers:
    "SELECT evtname,evtenabled FROM pg_event_trigger ORDER BY evtname",
  subscriptions: "SELECT subname FROM pg_subscription ORDER BY subname",
  foreignServers: "SELECT srvname FROM pg_foreign_server ORDER BY srvname",
};

export async function readCatalog(client: PoolClient): Promise<Catalog> {
  const catalog: Catalog = {};
  for (const [name, query] of Object.entries(CATALOG_SQL)) {
    catalog[name] = (await client.query(query)).rows as Row[];
  }
  catalog.routines = catalog.routines!.map(({ definition, ...row }) => ({
    ...row,
    definitionSha256: sha256(String(definition)),
  }));
  return catalog;
}

export function assertKnownFixture(c: Catalog): void {
  const identity = c.identity?.[0];
  if (
    identity?.database !== "midday_test" ||
    identity.role !== "postgres" ||
    identity.version !== "160015" ||
    identity.system_id !== FIXTURE_SYSTEM_ID
  ) {
    throw new FixtureRefusal(
      "Database identity differs from the reviewed PG16 fixture",
    );
  }
  if (
    canonical(c.schemas?.map((s) => s.nspname).sort()) !==
      canonical(["auth", "private", "public"]) ||
    canonical(c.databases?.map((d) => d.datname).sort()) !==
      canonical(["midday_test", "postgres"])
  ) {
    throw new FixtureRefusal(
      "Unexpected database or platform schema; no archive is allowed",
    );
  }
  const tables = c.relations!.filter((r) => r.kind === "r");
  if (
    tables.length !== 62 ||
    tables.some((r) => r.schema !== "public") ||
    c.relations!.some((r) => !["r", "i", "S"].includes(String(r.kind)))
  ) {
    throw new FixtureRefusal(
      "Expected exactly the reviewed 62-table Drizzle fixture",
    );
  }
  for (const key of [
    "memberships",
    "publications",
    "publicationTables",
    "eventTriggers",
    "subscriptions",
    "foreignServers",
  ]) {
    if (c[key]?.length !== 0)
      throw new FixtureRefusal(
        "Unexpected platform integration or role membership",
      );
  }
  if (
    canonical(
      c.extensions!.map((e) => [
        e.extname,
        e.extversion,
        e.extrelocatable,
        e.schema,
      ]),
    ) !==
    canonical([
      ["pg_trgm", "1.6", true, "public"],
      ["plpgsql", "1.0", false, "pg_catalog"],
      ["vector", "0.8.7", true, "public"],
    ])
  ) {
    throw new FixtureRefusal(
      "Only the reviewed relocatable vector and pg_trgm extensions may move",
    );
  }
  if (
    !c.availableExtensions!.some(
      (e) =>
        e.name === "pgcrypto" &&
        e.default_version === "1.3" &&
        e.installed_version === null,
    )
  ) {
    throw new FixtureRefusal(
      "Expected the reviewed available pgcrypto 1.3 extension",
    );
  }
  if (
    c.roles?.length !== 4 ||
    c.roles.some(
      (r) =>
        r.rolsuper ||
        r.rolcreatedb ||
        r.rolcreaterole ||
        r.rolbypassrls ||
        r.rolreplication ||
        (r.rolname !== "agsaas_app" && r.rolcanlogin),
    ) ||
    !c.roles.some(
      (r) => r.rolname === "agsaas_app" && r.rolcanlogin && !r.rolinherit,
    )
  ) {
    throw new FixtureRefusal(
      "Application role boundaries differ from the reviewed fixture",
    );
  }
}

async function assertNoOtherClients(client: PoolClient): Promise<void> {
  const result = await client.query(
    "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
  );
  if (result.rows[0]?.count !== 0)
    throw new FixtureRefusal("Another client is using the synthetic fixture");
}

async function readOnlyCatalog(client: PoolClient): Promise<Catalog> {
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(
      "SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5s'",
    );
    return await readCatalog(client);
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function inspectFoundation(
  client: PoolClient,
  sources = loadSources(),
) {
  const catalog = await readOnlyCatalog(client);
  assertKnownFixture(catalog);
  return {
    kind: FIXTURE_KIND,
    mode: "inspect",
    mutation: false,
    evidence: EVIDENCE,
    database: "midday_test",
    port: 55439,
    systemId: FIXTURE_SYSTEM_ID,
    catalogSha256: sha256(canonical(catalog)),
    sourceSetSha256: sources.sha256,
    archiveSchemas: SCHEMAS,
    preservedPublicTables: 62,
    relocateExtensions: catalog.extensions!.filter(
      (e) => e.schema === "public",
    ),
    previousApplicationRoleSettings: catalog.roles!.find(
      (r) => r.rolname === "agsaas_app",
    )?.rolconfig,
    sources: sources.receipts,
    requiredAcknowledgement: WRITE_ACK,
  };
}

export class FoundationFailure extends Error {
  constructor(
    readonly phase: string,
    readonly outcome: string,
    readonly sqlState: string | null,
  ) {
    super(
      "Synthetic foundation did not complete; inspect the reported outcome before retrying",
    );
    this.name = "FoundationFailure";
  }
}

async function verifyInstalled(
  client: PoolClient,
  prior: Catalog,
  archives: Record<string, string>,
) {
  for (const schema of SCHEMAS) {
    const expected = prior.schemas!.find((s) => s.nspname === schema)!;
    const result = await client.query(
      "SELECT oid::text FROM pg_namespace WHERE nspname=$1",
      [archives[schema]],
    );
    if (result.rows[0]?.oid !== expected.oid)
      throw new FixtureRefusal("Archived schema identity was not preserved");
  }
  const oldTables = prior.relations!.filter((r) => r.kind === "r");
  const preserved = await client.query(
    `SELECT oid::text,relnamespace::text AS namespace,relfilenode::text AS filenode
    FROM pg_class WHERE oid=ANY($1::oid[]) ORDER BY oid`,
    [oldTables.map((r) => r.oid)],
  );
  for (const table of oldTables) {
    const after = preserved.rows.find((r: Row) => r.oid === table.oid);
    if (
      after?.namespace !== table.namespace ||
      after?.filenode !== table.filenode
    ) {
      throw new FixtureRefusal(
        "An archived table identity or storage file changed",
      );
    }
  }
  const required = [
    "public.invoice_settlement_entries",
    "public.invoice_settlement_state",
    "public.security_audit_events",
    "public.resource_cleanups",
    "public.storage_deletion_tombstones",
    "public.request_resource_budgets",
    "public.heavy_job_admissions",
    "public.resource_admission_reconciliations",
    "public.team_quota_usage",
    "public.team_connector_reservations",
    "public.generated_storage_grants",
    "private.bank_sync_operations",
    "private.onboarding_deliveries",
    "private.storage_document_projection",
  ];
  const missing = await client.query(
    "SELECT name FROM unnest($1::text[]) name WHERE to_regclass(name) IS NULL",
    [required],
  );
  if (missing.rowCount !== 0)
    throw new FixtureRefusal(
      "A required application migration relation is missing",
    );
  const history = await client.query(
    "SELECT to_regnamespace('supabase_migrations')::text AS history",
  );
  if (history.rows[0]?.history !== null)
    throw new FixtureRefusal(
      "Synthetic setup must not create canonical migration history",
    );
  const extensions =
    await client.query(`SELECT e.oid::text,e.extname,e.extversion,n.nspname AS schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname IN ('vector','pg_trgm','pgcrypto') ORDER BY e.extname`);
  if (
    extensions.rowCount !== 3 ||
    extensions.rows.some((e: Row) => e.schema !== "extensions")
  ) {
    throw new FixtureRefusal("Extension relocation postcondition failed");
  }
  for (const before of prior.extensions!.filter((e) => e.schema === "public")) {
    if (
      !extensions.rows.some(
        (e: Row) => e.oid === before.oid && e.extversion === before.extversion,
      )
    ) {
      throw new FixtureRefusal(
        "Existing extension identity or version changed",
      );
    }
  }
  return {
    preservedTableOids: oldTables.map((r) => r.oid),
    extensions: extensions.rows,
  };
}

/** Caller must hold the host's shared queue; the SQL advisory lock serializes
 * this helper too. Never invoke it from a test's automatic setup hook. */
export async function executeFoundation(
  client: PoolClient,
  approvalValue: unknown,
  mode: Approval["mode"],
  unit: string,
  sources = loadSources(),
) {
  if (unit !== queueUnit(readFileSync("/proc/self/cgroup", "utf8"))) {
    throw new FixtureRefusal(
      "The write must remain inside its actual shared queue unit",
    );
  }
  let phase = "begin";
  let prior: Catalog | undefined;
  let commitSent = false;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='1500ms'; SET LOCAL statement_timeout='45s'; SET LOCAL idle_in_transaction_session_timeout='60s'",
    );
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(1095193409,20261103) AS acquired",
    );
    if (lock.rows[0]?.acquired !== true)
      throw new FixtureRefusal("Synthetic foundation is already in progress");
    phase = "catalog-preflight";
    await assertNoOtherClients(client);
    prior = await readCatalog(client);
    assertKnownFixture(prior);
    const beforeSha = sha256(canonical(prior));
    const approval = validateApproval(
      approvalValue,
      mode,
      beforeSha,
      sources.sha256,
    );
    const archives = archiveNames(approval.operationId);
    phase = "lock-preserved-tables";
    const tables = prior.relations!.filter((r) => r.kind === "r");
    await client.query(
      `LOCK TABLE ${tables.map((t) => `ONLY ${identifier(String(t.schema))}.${identifier(String(t.name))}`).join(",")} IN ACCESS EXCLUSIVE MODE NOWAIT`,
    );
    if (sha256(canonical(await readCatalog(client))) !== beforeSha)
      throw new FixtureRefusal(
        "Catalog changed while locking the original fixture",
      );
    await assertNoOtherClients(client);
    phase = "archive-original-schemas";
    for (const schema of SCHEMAS) {
      await client.query(
        `ALTER SCHEMA ${identifier(schema)} RENAME TO ${identifier(archives[schema]!)}`,
      );
      await client.query(
        `REVOKE ALL ON SCHEMA ${identifier(archives[schema]!)} FROM PUBLIC,anon,authenticated,agsaas_app,service_role`,
      );
    }
    await client.query(
      "CREATE SCHEMA public AUTHORIZATION pg_database_owner; CREATE SCHEMA extensions",
    );
    phase = "relocate-reviewed-extensions";
    await client.query(
      "ALTER EXTENSION vector SET SCHEMA extensions; ALTER EXTENSION pg_trgm SET SCHEMA extensions",
    );
    phase = "synthetic-platform";
    await client.query(sources.platform);
    for (const file of sources.files) {
      phase = file.path.split("/").at(-1)!;
      // Execute complete reviewed bytes. No tail extraction, IF NOT EXISTS
      // rewrites, invented history or replacement production prerequisites.
      await client.query(file.sql);
    }
    phase = "verify-foundation";
    const preserved = await verifyInstalled(client, prior, archives);
    await assertNoOtherClients(client);
    const receipt = {
      kind: FIXTURE_KIND,
      operationId: approval.operationId,
      evidence: EVIDENCE,
      database: "midday_test",
      port: 55439,
      systemId: FIXTURE_SYSTEM_ID,
      catalogBeforeSha256: beforeSha,
      sourceSetSha256: sources.sha256,
      queueUnit: unit,
      archives,
      ...preserved,
      sources: sources.receipts,
      previousApplicationRoleSettings: prior.roles!.find(
        (r) => r.rolname === "agsaas_app",
      )?.rolconfig,
    };
    phase = "record-private-provenance";
    await client.query(`CREATE TABLE private.agsaas_synthetic_fixture_provenance (
      operation_id uuid PRIMARY KEY, fixture_kind text NOT NULL CHECK(fixture_kind='agsaas-synthetic-foundation-v1'),
      installed_at timestamptz NOT NULL DEFAULT now(), receipt jsonb NOT NULL);
      REVOKE ALL ON private.agsaas_synthetic_fixture_provenance FROM PUBLIC,anon,authenticated,agsaas_app,service_role`);
    await client.query(
      "INSERT INTO private.agsaas_synthetic_fixture_provenance(operation_id,fixture_kind,receipt) VALUES($1,$2,$3::jsonb)",
      [approval.operationId, FIXTURE_KIND, JSON.stringify(receipt)],
    );
    if (mode === "rehearse") {
      // An actual PostgreSQL error after the complete chain must discard every
      // schema move, extension move, role setting, publication and provenance.
      phase = "intentional-final-failure";
      await client.query(
        "SELECT CAST('agsaas_synthetic_expected_failure' AS integer)",
      );
      throw new FixtureRefusal(
        "Expected PostgreSQL rollback fault was not raised",
      );
    }
    phase = "commit";
    commitSent = true;
    await client.query("COMMIT");
    transactionOpen = false;
    return { status: "committed", ...receipt };
  } catch (error) {
    const sqlState =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    if (commitSent)
      throw new FoundationFailure(
        phase,
        "commit-outcome-unknown-reinspect-provenance",
        sqlState,
      );
    let outcome = transactionOpen
      ? "rollback-unconfirmed"
      : "transaction-not-started";
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
        outcome = "rolled-back";
        if (prior) {
          const after = await readOnlyCatalog(client);
          outcome =
            sha256(canonical(after)) === sha256(canonical(prior))
              ? "rollback-catalog-verified"
              : "rollback-catalog-drift-requires-review";
        }
      } catch {
        /* A closed backend rolls back; do not claim verification. */
      }
    }
    if (
      mode === "rehearse" &&
      phase === "intentional-final-failure" &&
      sqlState === "22P02" &&
      outcome === "rollback-catalog-verified"
    ) {
      return {
        status: "rollback-verified",
        evidence: EVIDENCE,
        sourceSetSha256: sources.sha256,
        catalogSha256: sha256(canonical(prior)),
        injectedSqlState: sqlState,
      };
    }
    throw new FoundationFailure(phase, outcome, sqlState);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const inspect =
    args.length === 0 || (args.length === 1 && args[0] === "--inspect");
  const mode =
    args[0] === "--rehearse"
      ? "rehearse"
      : args[0] === "--apply"
        ? "commit"
        : null;
  if (!inspect && (!mode || args.length !== 3 || args[1] !== "--approval")) {
    throw new FixtureRefusal(
      "Use --inspect, --rehearse --approval FILE, or --apply --approval FILE",
    );
  }
  const sources = loadSources();
  let approval: unknown;
  let unit = "";
  if (!inspect) {
    if (process.env.AGSAAS_SYNTHETIC_FOUNDATION_WRITE !== WRITE_ACK)
      throw new FixtureRefusal(
        "Explicit write environment acknowledgement is required",
      );
    unit = queueUnit(readFileSync("/proc/self/cgroup", "utf8"));
    approval = readApproval(args[2]!);
  }
  const pool = new Pool({
    connectionString: fixtureUrl(),
    max: 1,
    connectionTimeoutMillis: 2000,
    application_name: "agsaas-synthetic-foundation-review",
  });
  const client = await pool.connect();
  try {
    const result = inspect
      ? await inspectFoundation(client, sources)
      : await executeFoundation(client, approval, mode!, unit, sources);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.release(true);
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // PostgreSQL diagnostics can include SQL values: never print the raw error,
    // stack, URL, password, or environment into the shared job output.
    console.error(
      JSON.stringify(
        error instanceof FoundationFailure
          ? {
              status: "failed",
              phase: error.phase,
              outcome: error.outcome,
              sqlState: error.sqlState,
            }
          : {
              status: "refused",
              reason:
                error instanceof FixtureRefusal ||
                error instanceof TestDatabaseConfigurationError
                  ? error.message
                  : "Source, approval or database preflight failed; inspect locally without exposing credentials",
            },
      ),
    );
    process.exitCode = 1;
  });
}
