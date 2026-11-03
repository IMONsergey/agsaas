import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// This runner is intentionally bound to one reviewed synthetic fixture and two
// complete SQL files. It is not an installer or a production migration command.
const KIND = "agsaas-synthetic-upgrades-v1";
const OPERATION_ID = "65020b23-1d5d-4c91-ad04-5694abcaf2bc";
const FOUNDATION_OPERATION = "0f191da4-bb92-4262-bcdb-2195cf109bcd";
const FOUNDATION_SOURCES =
  "343e96a887bd93aac9f0eec6c1d22a4873f01819ecefcbdff3d3af8071052ff3";
const SYSTEM_ID = "7703819082990792743";
const PG_ROOT = "/home/sergey/Work/agsaas-postgres-review-20261103";
const PG_HEAD = "e97363ad33b08a1737e7ea77dffadc7a868db355";
const PG_PACKAGE_SHA =
  "b1e53333a3d0c2c47c49a5cb919d221135dc03145df740925b899bc2baacc435";
const UPGRADES = [
  {
    version: "20261103110000",
    repository: "/home/sergey/Work/finance-resume-source-20261103",
    reviewedCommit: "c848d0d183d47f864268e2ed42316c7faf898d4e",
    path: "packages/db/self-hosted/upgrades/supabase/migrations/20261103110000_invoice_refund_requests.sql",
    sha256: "acf11ab88ab8ebb5aa05b90dafd9b22560802aa443bd74e6d03c8dabc2ed0ddb",
  },
  {
    version: "20261103111000",
    repository: "/home/sergey/Work/security-consent-20261103",
    reviewedCommit: "a32467248cdd027fc18f7b660d13861089790c2b",
    path: "packages/db/self-hosted/upgrades/supabase/migrations/20261103111000_plaid_hosted_consent.sql",
    sha256: "d0c6fc87d32cfec15561f4814475d6db1d6e08fc777fad6f5dc5d18d502a4933",
  },
];
const EVIDENCE = {
  label:
    "Two reviewed append-only upgrades on the synthetic PostgreSQL 16 application fixture",
  actualAuthService: false,
  actualStorageService: false,
  actualRealtimeService: false,
  postgresql17Acceptance: false,
  canonicalMigrationHistory: false,
};
const JOURNAL = "private.agsaas_synthetic_upgrade_provenance";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Invalid fingerprint value");
  return result;
}
function requireCondition(value, code) {
  if (!value) {
    const error = new Error(code);
    error.refusal = code;
    throw error;
  }
}
function queueUnit() {
  requireCondition(
    process.getuid?.() === 1000 && process.geteuid?.() === 1000,
    "ordinary-uid-1000-required",
  );
  const unit = readFileSync("/proc/self/cgroup", "utf8").match(
    /(?:^|\/)(imon-job@[0-9]{8}T[0-9]{6}-[a-f0-9]{10}\.service)(?:\/|$)/m,
  )?.[1];
  requireCondition(unit, "shared-imon-job-cgroup-required");
  return unit;
}
function git(root, ...args) {
  return execFileSync(
    "/usr/bin/git",
    ["--no-optional-locks", "--no-pager", "-C", root, ...args],
    { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
  );
}
function ownedJson(path) {
  requireCondition(isAbsolute(path), "absolute-rehearsal-receipt-required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireCondition(
      stat.isFile() &&
        stat.uid === 1000 &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size < 131072,
      "owned-private-rehearsal-receipt-required",
    );
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
function sources() {
  requireCondition(
    git(PG_ROOT, "rev-parse", "HEAD").toString().trim() === PG_HEAD &&
      git(PG_ROOT, "status", "--porcelain").length === 0,
    "frozen-pg-review-changed",
  );
  requireCondition(
    sha256(readFileSync(`${PG_ROOT}/node_modules/pg/package.json`)) ===
      PG_PACKAGE_SHA,
    "installed-pg-package-changed",
  );
  return UPGRADES.map((file) => {
    const raw = readFileSync(`${file.repository}/${file.path}`);
    requireCondition(
      sha256(raw) === file.sha256 &&
        sha256(
          git(file.repository, "show", `${file.reviewedCommit}:${file.path}`),
        ) === file.sha256,
      `reviewed-sql-changed-${file.version}`,
    );
    const sql = raw.toString("utf8");
    requireCondition(Buffer.from(sql).equals(raw), "sql-must-be-exact-utf8");
    return { ...file, sql };
  });
}
function connection() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  requireCondition(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname === "127.0.0.1" &&
      url.port === "55439" &&
      url.pathname === "/midday_test" &&
      !url.hash &&
      url.username &&
      url.password,
    "reviewed-loopback-database-url-required",
  );
  const entries = [...url.searchParams.entries()];
  requireCondition(
    entries.length === 0 ||
      (entries.length === 1 &&
        entries[0][0] === "sslmode" &&
        entries[0][1] === "disable"),
    "connection-overrides-refused",
  );
  // Never pass URL query parameters through to pg. Host/port/database are fixed.
  return {
    host: "127.0.0.1",
    port: 55439,
    database: "midday_test",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: false,
    connectionTimeoutMillis: 5000,
  };
}

// Catalog only: no business rows, credentials or function bodies are emitted.
// Adapted from the reviewed synthetic-foundation catalog, with archived schemas
// included so rollback also checks their relation, constraint and routine OIDs.
const APPLICATION_SCHEMA =
  "n.nspname !~ '^pg_' AND n.nspname<>'information_schema'";
const CATALOG_SQL = {
  identity: `SELECT current_database() AS database,current_user AS role,current_setting('server_version_num') AS version,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_id,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid`,
  schemas: `SELECT oid::text,nspname,nspowner::text,nspacl::text FROM pg_namespace n WHERE ${APPLICATION_SCHEMA} ORDER BY nspname`,
  relations: `SELECT c.oid::text,n.nspname,c.relname,c.relkind,c.relfilenode::text,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${APPLICATION_SCHEMA} ORDER BY n.nspname,c.relname`,
  columns: `SELECT a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl::text,
    pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE ${APPLICATION_SCHEMA} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum`,
  constraints: `SELECT c.oid::text,c.conrelid::text,c.confrelid::text,c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE ${APPLICATION_SCHEMA} ORDER BY c.oid`,
  routines: `SELECT p.oid::text,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args,p.proowner::text,p.proacl::text,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${APPLICATION_SCHEMA} AND p.prokind<>'a' ORDER BY p.oid`,
  triggers: `SELECT t.oid::text,t.tgrelid::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${APPLICATION_SCHEMA} AND NOT t.tgisinternal ORDER BY t.oid`,
  policies:
    "SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname !~ '^pg_' AND schemaname<>'information_schema' ORDER BY schemaname,tablename,policyname",
  indexes:
    "SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname !~ '^pg_' AND schemaname<>'information_schema' ORDER BY schemaname,tablename,indexname",
  enums: `SELECT t.oid::text,n.nspname,t.typname,e.enumsortorder,e.enumlabel FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    JOIN pg_enum e ON e.enumtypid=t.oid WHERE ${APPLICATION_SCHEMA} ORDER BY t.oid,e.enumsortorder`,
  extensions:
    "SELECT e.oid::text,e.extname,e.extversion,e.extrelocatable,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname",
  roles:
    "SELECT oid::text,rolname,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,rolreplication,rolcanlogin,rolconfig FROM pg_roles WHERE rolname IN ('agsaas_app','anon','authenticated','service_role') ORDER BY rolname",
  memberships:
    "SELECT m.roleid::text,m.member::text,m.admin_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('agsaas_app','anon','authenticated','service_role') ORDER BY m.roleid,m.member",
  publications:
    "SELECT pubname,puballtables,pubinsert,pubupdate,pubdelete,pubtruncate FROM pg_publication ORDER BY pubname",
  publicationTables:
    "SELECT pubname,schemaname,tablename FROM pg_publication_tables ORDER BY pubname,schemaname,tablename",
  eventTriggers:
    "SELECT evtname,evtenabled FROM pg_event_trigger ORDER BY evtname",
  subscriptions: "SELECT subname FROM pg_subscription ORDER BY subname",
  foreignServers: "SELECT srvname FROM pg_foreign_server ORDER BY srvname",
};
async function catalog(client) {
  const result = {};
  for (const [key, sql] of Object.entries(CATALOG_SQL))
    result[key] = (await client.query(sql)).rows;
  result.routines = result.routines.map(({ definition, ...row }) => ({
    ...row,
    definitionSha256: sha256(definition),
  }));
  return result;
}
async function begin(client, readOnly) {
  await client.query(
    readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
  );
  transactionOpen = true;
  await client.query(
    "SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='1500ms'; SET LOCAL statement_timeout='45s'; SET LOCAL idle_in_transaction_session_timeout='60s'",
  );
  requireCondition(
    (
      await client.query(
        "SELECT pg_try_advisory_xact_lock(1095193409,20261103) AS acquired",
      )
    ).rows[0]?.acquired === true,
    "synthetic-fixture-advisory-lock-busy",
  );
}
async function noOtherClients(client) {
  requireCondition(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
      )
    ).rows[0]?.count === 0,
    "another-client-is-using-isolated-fixture",
  );
}
async function foundation(client, lock) {
  const identity = (
    await client.query(
      "SELECT current_database() AS database,system_identifier::text AS system_id FROM pg_control_system()",
    )
  ).rows[0];
  requireCondition(
    identity?.database === "midday_test" && identity.system_id === SYSTEM_ID,
    "database-system-identity-mismatch",
  );
  const row = (
    await client.query(
      `SELECT operation_id::text,fixture_kind,installed_at::text,receipt FROM private.agsaas_synthetic_fixture_provenance WHERE operation_id=$1${lock ? " FOR SHARE" : ""}`,
      [FOUNDATION_OPERATION],
    )
  ).rows[0];
  requireCondition(
    row?.fixture_kind === "agsaas-synthetic-foundation-v1" &&
      row.receipt?.operationId === FOUNDATION_OPERATION &&
      row.receipt?.sourceSetSha256 === FOUNDATION_SOURCES &&
      row.receipt?.database === "midday_test" &&
      row.receipt?.port === 55439 &&
      row.receipt?.systemId === SYSTEM_ID,
    "synthetic-foundation-marker-mismatch",
  );
  return sha256(canonical(row));
}
async function priorReceipt(client) {
  const exists = (
    await client.query("SELECT to_regclass($1)::text AS relation", [JOURNAL])
  ).rows[0]?.relation;
  if (!exists) return { exists: false, rows: [] };
  const rows = (
    await client.query(
      `SELECT operation_id::text,fixture_kind,foundation_operation_id::text,foundation_source_sha256,source_set_sha256,source_manifest,receipt FROM ${JOURNAL} WHERE operation_id=$1 OR source_set_sha256=$2`,
      [OPERATION_ID, SOURCE_SET_SHA],
    )
  ).rows;
  return { exists: true, rows };
}
async function targetObjects(client, expected) {
  const relations = [
    "public.invoice_refund_requests",
    "public.hosted_bank_consents",
  ];
  const functions = [
    "public.guard_invoice_refund_request()",
    "private.lock_hosted_bank_consent_session(uuid,uuid,text)",
    "private.cancel_hosted_bank_consents()",
  ];
  for (const name of relations)
    requireCondition(
      Boolean(
        (await client.query("SELECT to_regclass($1) AS oid", [name])).rows[0]
          ?.oid,
      ) === expected,
      "unexpected-upgrade-table-state",
    );
  for (const name of functions)
    requireCondition(
      Boolean(
        (await client.query("SELECT to_regprocedure($1) AS oid", [name]))
          .rows[0]?.oid,
      ) === expected,
      "unexpected-upgrade-function-state",
    );
  if (expected) {
    const enabled = (
      await client.query(
        "SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind='r' AND c.relrowsecurity",
        [["invoice_refund_requests", "hosted_bank_consents"]],
      )
    ).rows[0]?.count;
    requireCondition(enabled === 2, "new-tables-must-have-rls");
    const names = [
      "invoice_refund_request_guard",
      "agsaas_hosted_consent_session_revoked",
      "agsaas_hosted_consent_team_deleted",
      "agsaas_hosted_consent_user_deleted",
      "agsaas_hosted_consent_membership_changed",
    ];
    requireCondition(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM pg_trigger WHERE tgname=ANY($1::text[]) AND NOT tgisinternal AND tgenabled='O'",
          [names],
        )
      ).rows[0]?.count === names.length,
      "required-upgrade-triggers-missing",
    );
  }
}
const JOURNAL_SQL = `CREATE TABLE private.agsaas_synthetic_upgrade_provenance (
  operation_id uuid PRIMARY KEY, fixture_kind text NOT NULL CHECK(fixture_kind='agsaas-synthetic-upgrades-v1'),
  foundation_operation_id uuid NOT NULL REFERENCES private.agsaas_synthetic_fixture_provenance(operation_id) ON DELETE RESTRICT,
  foundation_source_sha256 text NOT NULL CHECK(foundation_source_sha256 ~ '^[a-f0-9]{64}$'),
  source_set_sha256 text NOT NULL UNIQUE CHECK(source_set_sha256 ~ '^[a-f0-9]{64}$'), source_manifest jsonb NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(), receipt jsonb NOT NULL);
CREATE FUNCTION private.guard_synthetic_upgrade_provenance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
BEGIN RAISE EXCEPTION 'Synthetic upgrade provenance is append-only'; END;
$guard$;
CREATE TRIGGER agsaas_synthetic_upgrade_append_only BEFORE UPDATE OR DELETE ON private.agsaas_synthetic_upgrade_provenance
  FOR EACH ROW EXECUTE FUNCTION private.guard_synthetic_upgrade_provenance();
CREATE TRIGGER agsaas_synthetic_upgrade_no_truncate BEFORE TRUNCATE ON private.agsaas_synthetic_upgrade_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_synthetic_upgrade_provenance();
REVOKE ALL ON private.agsaas_synthetic_upgrade_provenance FROM PUBLIC,anon,authenticated,agsaas_app,service_role;
REVOKE ALL ON FUNCTION private.guard_synthetic_upgrade_provenance() FROM PUBLIC,anon,authenticated,agsaas_app,service_role;`;
const SOURCE_SET_SHA = sha256(canonical(UPGRADES));
const RUNNER_SHA = sha256(readFileSync(fileURLToPath(import.meta.url)));
const LAUNCHER_SHA = process.env.AGSAAS_SYNTHETIC_UPGRADE_LAUNCHER_SHA256;
let phase = "source-preflight",
  transactionOpen = false,
  commitSent = false,
  commitAcknowledged = false;
let client, beforeCatalogSha, foundationSha, mode, unit;
async function rollbackVerification() {
  if (transactionOpen) await client.query("ROLLBACK");
  transactionOpen = false;
  await begin(client, true);
  transactionOpen = true;
  await noOtherClients(client);
  const afterCatalog = sha256(canonical(await catalog(client)));
  const afterMarker = await foundation(client, false);
  await client.query("ROLLBACK");
  transactionOpen = false;
  requireCondition(
    afterCatalog === beforeCatalogSha && afterMarker === foundationSha,
    "rollback-catalog-or-foundation-marker-drift",
  );
  return {
    catalogBeforeSha256: beforeCatalogSha,
    catalogAfterRollbackSha256: afterCatalog,
    foundationMarkerSha256: afterMarker,
  };
}
function common() {
  return {
    kind: KIND,
    operationId: OPERATION_ID,
    mode,
    queueUnit: unit,
    ordinaryUid: process.getuid?.(),
    endpoint: "127.0.0.1:55439",
    database: "midday_test",
    systemId: SYSTEM_ID,
    foundationOperationId: FOUNDATION_OPERATION,
    foundationSourceSetSha256: FOUNDATION_SOURCES,
    sourceSetSha256: SOURCE_SET_SHA,
    sources: UPGRADES,
    runnerSha256: RUNNER_SHA,
    launcherSha256: LAUNCHER_SHA,
    evidence: EVIDENCE,
  };
}
async function main() {
  unit = queueUnit();
  requireCondition(
    /^[a-f0-9]{64}$/.test(LAUNCHER_SHA ?? ""),
    "sterile-launcher-required",
  );
  const args = process.argv.slice(2);
  [mode] = args;
  requireCondition(
    args.length === 3 && ["inspect", "rehearse", "commit"].includes(mode),
    "explicit-mode-required",
  );
  const expectedCatalog = args[1],
    rehearsalPath = args[2];
  requireCondition(
    mode === "inspect"
      ? expectedCatalog === "-" && rehearsalPath === "-"
      : /^[a-f0-9]{64}$/.test(expectedCatalog) &&
          (mode === "commit" ? rehearsalPath !== "-" : rehearsalPath === "-"),
    "mode-arguments-mismatch",
  );
  const sqlFiles = sources();
  let rehearsal;
  if (mode === "commit") {
    rehearsal = ownedJson(rehearsalPath);
    requireCondition(
      rehearsal.kind === KIND &&
        rehearsal.mode === "rehearse" &&
        rehearsal.operationId === OPERATION_ID &&
        rehearsal.status === "rollback-verified" &&
        rehearsal.ordinaryUid === 1000 &&
        rehearsal.database === "midday_test" &&
        rehearsal.endpoint === "127.0.0.1:55439" &&
        rehearsal.systemId === SYSTEM_ID &&
        rehearsal.sourceSetSha256 === SOURCE_SET_SHA &&
        canonical(rehearsal.sources) === canonical(UPGRADES) &&
        rehearsal.runnerSha256 === RUNNER_SHA &&
        rehearsal.launcherSha256 === LAUNCHER_SHA &&
        rehearsal.foundationOperationId === FOUNDATION_OPERATION &&
        rehearsal.foundationSourceSetSha256 === FOUNDATION_SOURCES &&
        rehearsal.catalogBeforeSha256 === expectedCatalog &&
        rehearsal.catalogAfterRollbackSha256 === expectedCatalog &&
        rehearsal.injectedSqlState === "22P02" &&
        /^imon-job@/.test(rehearsal.queueUnit),
      "successful-exact-rehearsal-receipt-required",
    );
  }
  const require = createRequire(`${PG_ROOT}/package.json`);
  const { Client } = require("pg");
  client = new Client(connection());
  client.on("error", () => {});
  phase = "connect-reviewed-loopback-fixture";
  await client.connect();
  phase = "transaction-preflight";
  await begin(client, mode === "inspect");
  transactionOpen = true;
  await noOtherClients(client);
  foundationSha = await foundation(client, mode !== "inspect");
  if (mode === "commit")
    requireCondition(
      rehearsal.foundationMarkerSha256 === foundationSha,
      "foundation-marker-changed-since-rehearsal",
    );
  beforeCatalogSha = sha256(canonical(await catalog(client)));
  const prior = await priorReceipt(client);
  if (prior.rows.length) {
    requireCondition(prior.rows.length === 1, "conflicting-upgrade-provenance");
    const row = prior.rows[0],
      receipt = row.receipt;
    requireCondition(
      row.operation_id === OPERATION_ID &&
        row.fixture_kind === KIND &&
        row.foundation_operation_id === FOUNDATION_OPERATION &&
        row.foundation_source_sha256 === FOUNDATION_SOURCES &&
        row.source_set_sha256 === SOURCE_SET_SHA &&
        canonical(row.source_manifest) === canonical(UPGRADES) &&
        receipt.kind === KIND &&
        receipt.operationId === OPERATION_ID &&
        canonical(receipt.sources) === canonical(UPGRADES) &&
        receipt.sourceSetSha256 === SOURCE_SET_SHA &&
        receipt.runnerSha256 === RUNNER_SHA &&
        receipt.launcherSha256 === LAUNCHER_SHA &&
        receipt.foundationMarkerSha256 === foundationSha &&
        receipt.catalogAfterSha256 === beforeCatalogSha &&
        (mode === "inspect" || receipt.catalogBeforeSha256 === expectedCatalog),
      "existing-upgrade-provenance-or-catalog-mismatch",
    );
    await targetObjects(client, true);
    await client.query("ROLLBACK");
    transactionOpen = false;
    return {
      ...common(),
      status: "already-applied-verified",
      catalogSha256: beforeCatalogSha,
      foundationMarkerSha256: foundationSha,
    };
  }
  // Never adopt a preexisting table, rewrite a partial upgrade, or invent history.
  requireCondition(!prior.exists, "unrecognized-existing-upgrade-journal");
  await targetObjects(client, false);
  if (mode === "inspect") {
    await client.query("ROLLBACK");
    transactionOpen = false;
    return {
      ...common(),
      status: "ready-for-reviewed-rehearsal",
      catalogSha256: beforeCatalogSha,
      foundationMarkerSha256: foundationSha,
    };
  }
  requireCondition(
    expectedCatalog === beforeCatalogSha,
    "catalog-changed-since-reviewed-inspect",
  );
  for (const file of sqlFiles) {
    phase = `apply-${file.version}`;
    await client.query(file.sql);
  }
  phase = "separate-append-only-provenance";
  await client.query(JOURNAL_SQL);
  await targetObjects(client, true);
  requireCondition(
    (await foundation(client, true)) === foundationSha,
    "baseline-marker-changed",
  );
  await noOtherClients(client);
  const afterCatalogSha = sha256(canonical(await catalog(client)));
  const receipt = {
    ...common(),
    mode: "commit",
    catalogBeforeSha256: beforeCatalogSha,
    catalogAfterSha256: afterCatalogSha,
    foundationMarkerSha256: foundationSha,
    installedAt: new Date().toISOString(),
  };
  await client.query(
    `INSERT INTO ${JOURNAL}(operation_id,fixture_kind,foundation_operation_id,foundation_source_sha256,source_set_sha256,source_manifest,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [
      OPERATION_ID,
      KIND,
      FOUNDATION_OPERATION,
      FOUNDATION_SOURCES,
      SOURCE_SET_SHA,
      JSON.stringify(UPGRADES),
      JSON.stringify(receipt),
    ],
  );
  if (mode === "rehearse") {
    phase = "intentional-final-failure";
    try {
      await client.query(
        "SELECT CAST('agsaas_append_upgrade_expected_failure' AS integer)",
      );
    } catch (error) {
      requireCondition(error?.code === "22P02", "unexpected-rehearsal-fault");
      const verification = await rollbackVerification();
      return {
        ...common(),
        status: "rollback-verified",
        ...verification,
        injectedSqlState: "22P02",
      };
    }
    throw new Error("Expected rollback fault was not raised");
  }
  phase = "commit";
  commitSent = true;
  await client.query("COMMIT");
  commitAcknowledged = true;
  transactionOpen = false;
  // The durable SQL receipt is authoritative if the connection or output fails.
  phase = "post-commit-verification";
  await begin(client, true);
  transactionOpen = true;
  const persisted = await priorReceipt(client);
  requireCondition(
    persisted.rows.length === 1 &&
      canonical(persisted.rows[0].receipt) === canonical(receipt) &&
      sha256(canonical(await catalog(client))) === afterCatalogSha &&
      (await foundation(client, false)) === foundationSha,
    "committed-receipt-verification-failed",
  );
  await client.query("ROLLBACK");
  transactionOpen = false;
  return { ...receipt, status: "committed-and-verified" };
}
try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  let outcome = commitAcknowledged
    ? "commit-acknowledged-verification-failed-inspect-provenance"
    : commitSent
      ? "commit-outcome-unknown-inspect-provenance"
      : "no-commit-sent";
  if (!commitSent && client && transactionOpen) {
    try {
      if (beforeCatalogSha && foundationSha) {
        await rollbackVerification();
        outcome = "rollback-catalog-verified";
      } else {
        await client.query("ROLLBACK");
        transactionOpen = false;
        outcome = "rolled-back-before-catalog-proof";
      }
    } catch {
      outcome = "rollback-unconfirmed-inspect-provenance";
    }
  }
  const code =
    typeof error?.code === "string" && /^[A-Z0-9_]{2,48}$/.test(error.code)
      ? error.code
      : null;
  process.stdout.write(
    `${JSON.stringify({ ...common(), status: "failed", phase, outcome, code, refusal: typeof error?.refusal === "string" && /^[a-z0-9-]{1,100}$/.test(error.refusal) ? error.refusal : null }, null, 2)}\n`,
  );
  process.exitCode = commitSent ? 2 : 1;
} finally {
  if (client) await client.end().catch(() => {});
}
