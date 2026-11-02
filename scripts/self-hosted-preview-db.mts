import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnvironment } from "./prepare-self-hosted.mts";
import {
  baselineHistorySql,
  provisioningSql,
  verificationSql,
} from "./self-hosted-db.mts";
import { upgradeStatements } from "./self-hosted-rehearsal.mts";

// This is a separate, explicitly authorized installation. The private-stage and
// restored-rehearsal helpers retain their original fixed deployment guards.
export const PREVIEW = {
  project: "agsaas-preview-20261101",
  runtime: "/opt/agsaas/preview-20261101/runtime/supabase",
  source: "/opt/agsaas/preview-20261101/source",
  container: "agsaas-preview-20261101-db",
  image: "supabase/postgres:17.6.1.136",
  dashboard: "https://94.249.186.240:8543",
  api: "https://94.249.186.240:8544",
  supabase: "https://94.249.186.240:8545",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  assert(result.status === 0, `${command} failed; private output suppressed`);
  return result.stdout;
}

function git(...args: string[]): string {
  return run("git", [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-C",
    PREVIEW.source,
    ...args,
  ]).trim();
}

function privateFile(path: string): string {
  const stat = lstatSync(path);
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === 0 &&
      (stat.mode & 0o777) === 0o600 &&
      realpathSync(path) === path,
    "Unsafe private preview file",
  );
  return readFileSync(path, "utf8");
}

export function validatePreviewEnvironment(
  env: Record<string, string>,
): string {
  assert(
    env.COMPOSE_PROJECT_NAME === PREVIEW.project &&
      env.AGSAAS_SOURCE_DIR === PREVIEW.source,
    "Preview identity mismatch",
  );
  assert(
    env.AGSAAS_DASHBOARD_URL === PREVIEW.dashboard &&
      env.AGSAAS_API_URL === PREVIEW.api &&
      env.SUPABASE_PUBLIC_URL === PREVIEW.supabase,
    "Preview public URL mismatch",
  );
  assert(
    env.SITE_URL === PREVIEW.dashboard &&
      env.API_EXTERNAL_URL === `${PREVIEW.supabase}/auth/v1`,
    "Preview Auth URL mismatch",
  );
  assert(
    env.DISABLE_SIGNUP === "true" &&
      env.ENABLE_EMAIL_AUTOCONFIRM === "false" &&
      env.AUTH_ENABLED_PROVIDERS === "password",
    "Preview Auth policy mismatch",
  );
  assert(
    env.FUNCTIONS_VERIFY_JWT === "true" &&
      !env.COMPOSE_FILE?.includes("mail-test"),
    "Preview platform policy mismatch",
  );
  const password = env.AGSAAS_DB_PASSWORD;
  assert(
    password && /^[a-f0-9]{64}$/.test(password),
    "Invalid preview backend credential",
  );
  assert(env.POOLER_TENANT_ID === PREVIEW.project, "Preview pooler mismatch");
  assert(
    env.AGSAAS_DATABASE_URL ===
      `postgresql://agsaas_app:${password}@db:5432/postgres?sslmode=disable`,
    "Preview backend URL mismatch",
  );
  assert(
    env.AGSAAS_WORKER_DATABASE_URL ===
      `postgresql://agsaas_app.${PREVIEW.project}:${password}@supavisor:6543/postgres?sslmode=disable`,
    "Preview worker URL mismatch",
  );
  return password;
}

export function validatePreviewContainer(value: unknown): string {
  const d = value as {
    Id: string;
    Name: string;
    Config: { Image: string; Labels: Record<string, string> };
    State: { Running: boolean; Health?: { Status: string } };
    Mounts: {
      Type: string;
      Source: string;
      Destination: string;
      RW: boolean;
    }[];
  };
  assert(
    d && /^[a-f0-9]{64}$/.test(d.Id) && d.Name === `/${PREVIEW.container}`,
    "Preview container identity mismatch",
  );
  assert(
    d.Config?.Image === PREVIEW.image &&
      d.Config.Labels?.["com.docker.compose.project"] === PREVIEW.project &&
      d.Config.Labels?.["com.docker.compose.service"] === "db" &&
      d.Config.Labels?.["com.docker.compose.project.working_dir"] ===
        PREVIEW.runtime,
    "Preview Docker labels mismatch",
  );
  assert(
    d.State?.Running && d.State.Health?.Status === "healthy",
    "Preview database is not healthy",
  );
  const data = d.Mounts?.filter(
    (m) => m.Destination === "/var/lib/postgresql/data",
  );
  assert(
    data?.length === 1 &&
      data[0]?.Type === "bind" &&
      data[0]?.Source === `${PREVIEW.runtime}/volumes/db/data` &&
      data[0]?.RW,
    "Preview data mount mismatch",
  );
  return d.Id;
}

function psql(id: string, input: string, atomic = false): string {
  return run(
    "docker",
    [
      "--host",
      "unix:///var/run/docker.sock",
      "exec",
      "-i",
      "--user",
      "postgres",
      "--env",
      "PGCONNECT_TIMEOUT=5",
      "--env",
      "PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=5000 -c transaction_timeout=45000 -c idle_in_transaction_session_timeout=45000",
      id,
      "psql",
      "--host",
      "/var/run/postgresql",
      "--port",
      "5432",
      "--username",
      "supabase_admin",
      "--dbname",
      "postgres",
      "--no-password",
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--set",
      "VERBOSITY=sqlstate",
      "--set",
      "SHOW_CONTEXT=never",
      "--file=-",
      ...(atomic ? ["--single-transaction"] : []),
    ],
    input,
  ).trim();
}

function readTracked(path: string): string {
  git("ls-files", "--error-unmatch", "--", path);
  const absolute = `${PREVIEW.source}/${path}`;
  assert(
    realpathSync(absolute) === absolute && lstatSync(absolute).isFile(),
    "Unsafe preview source file",
  );
  return readFileSync(absolute, "utf8");
}

function guard(): { id: string; password: string; commit: string } {
  assert(
    process.geteuid?.() === 0,
    "Preview operations require the deployment owner",
  );
  for (const path of [PREVIEW.runtime, PREVIEW.source]) {
    const stat = lstatSync(path);
    assert(
      stat.isDirectory() &&
        stat.uid === 0 &&
        (stat.mode & 0o022) === 0 &&
        realpathSync(path) === path,
      "Unsafe preview directory",
    );
  }
  const env = parseEnvironment(privateFile(`${PREVIEW.runtime}/.env`));
  const password = validatePreviewEnvironment(env);
  const manifest = JSON.parse(
    privateFile(`${PREVIEW.runtime}/deployment-manifest.json`),
  );
  assert(
    ["public-preview-prepared", "public-preview"].includes(manifest.mode) &&
      manifest.project === PREVIEW.project &&
      manifest.publicSignupEnabled === false,
    "Preview manifest mismatch",
  );
  assert(
    !git("status", "--porcelain", "--untracked-files=all"),
    "Preview source must be clean",
  );
  const commit = git("rev-parse", "HEAD");
  assert(
    /^[a-f0-9]{40}$/.test(commit) && commit === env.AGSAAS_RELEASE,
    "Preview source release mismatch",
  );
  const containers = JSON.parse(
    run("docker", [
      "--host",
      "unix:///var/run/docker.sock",
      "inspect",
      PREVIEW.container,
    ]),
  );
  assert(containers.length === 1, "Unexpected preview database result");
  const id = validatePreviewContainer(containers[0]);
  for (const service of ["api", "worker", "dashboard"]) {
    assert(
      !run("docker", [
        "--host",
        "unix:///var/run/docker.sock",
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${PREVIEW.project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ]).trim(),
      "Stop preview application writers before database changes",
    );
  }
  return { id, password, commit };
}

export function runPreviewDatabase(mode: string): Record<string, unknown> {
  assert(
    mode === "bootstrap" || mode === "upgrade",
    "Use bootstrap or upgrade only",
  );
  const { id, password, commit } = guard();
  const baselineName = "20261031154237_application_baseline.sql";
  const baseline = readTracked(
    `packages/db/self-hosted/supabase/migrations/${baselineName}`,
  );
  const digest = createHash("sha256").update(baseline).digest("hex");
  if (mode === "bootstrap") {
    const empty = psql(
      id,
      "SELECT (NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='agsaas_app') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname='public') AND NOT EXISTS (SELECT 1 FROM auth.users) AND NOT EXISTS (SELECT 1 FROM storage.objects))::text;\n",
    );
    assert(
      empty === "true",
      "Preview bootstrap requires a fresh application database",
    );
    const provision = provisioningSql(password);
    const verifier = readTracked("packages/db/self-hosted/verify.sql");
    // Verify role provisioning and the exact baseline inside a rolled-back transaction.
    psql(id, verificationSql(`${provision}\n${baseline}`, verifier));
    // Role, application DDL and CLI history then commit as one operation.
    psql(
      id,
      `${provision}\n${baseline}\n${baselineHistorySql(baseline, baselineName, commit)}`,
      true,
    );
    return {
      mode,
      project: PREVIEW.project,
      commit,
      baselineSha256: digest,
      verifiedWithRollback: true,
      atomic: true,
    };
  }
  const recorded = psql(
    id,
    "SELECT sha256 FROM private.agsaas_baseline_installation WHERE version='20261031154237';\n",
  );
  assert(recorded === digest, "Preview baseline checksum mismatch");
  const history = JSON.parse(
    psql(
      id,
      "SELECT coalesce(json_agg(json_build_object('version',version,'name',name,'statements',statements) ORDER BY version),'[]'::json) FROM supabase_migrations.schema_migrations;\n",
    ),
  ) as { version: string; name: string; statements: string[] }[];
  const directory = "packages/db/self-hosted/upgrades/supabase/migrations";
  const files = readdirSync(`${PREVIEW.source}/${directory}`)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const upgrades = files.map((filename) => {
    const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename);
    assert(match, "Unexpected preview migration filename");
    const sql = readTracked(`${directory}/${filename}`);
    return {
      filename,
      version: match[1]!,
      name: match[2]!,
      sql,
      statements: upgradeStatements(sql),
    };
  });
  assert(
    history[0]?.version === "20261031154237" &&
      history[0]?.name === "application_baseline",
    "Unexpected preview baseline history",
  );
  for (const entry of history.slice(1)) {
    const source = upgrades.find((u) => u.version === entry.version);
    assert(
      source &&
        entry.name === source.name &&
        JSON.stringify(entry.statements) === JSON.stringify(source.statements),
      "Preview migration history differs from reviewed source",
    );
  }
  const pending = upgrades.filter(
    (u) => !history.some((h) => h.version === u.version),
  );
  assert(
    pending.every((u) => u.version > history.at(-1)!.version),
    "Refusing out-of-order preview migration",
  );
  for (const migration of pending) {
    const encoded = migration.statements.map(
      (statement) =>
        `convert_from(decode('${Buffer.from(statement).toString("base64")}','base64'),'UTF8')`,
    );
    psql(
      id,
      `${migration.sql}\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('${migration.version}','${migration.name}',ARRAY[${encoded.join(",")}]);`,
      true,
    );
  }
  return {
    mode,
    project: PREVIEW.project,
    commit,
    applied: pending.map((m) => m.filename),
    alreadyApplied: history.length,
    atomicPerMigration: true,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    assert(
      process.argv.length === 3,
      "Usage: node scripts/self-hosted-preview-db.mts bootstrap|upgrade",
    );
    console.log(JSON.stringify(runPreviewDatabase(process.argv[2]!), null, 2));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Preview database operation failed; private details suppressed",
    );
    process.exitCode = 1;
  }
}
