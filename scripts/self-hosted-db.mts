import { spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseEnvironment,
  SUPABASE_COMMIT,
  SUPABASE_RELEASE,
} from "./prepare-self-hosted.mts";

const RUNTIME = "/opt/agsaas/runtime/supabase";
const SOURCE = "/opt/agsaas/source";
const PROJECT = "agsaas-stage";
const CONTAINER = "agsaas-stage-db";
const IMAGE = "supabase/postgres:17.6.1.136";
const DATA_DIRECTORY = `${RUNTIME}/volumes/db/data`;
const DOCKER_HOST = "unix:///var/run/docker.sock";
const BASELINE_DIRECTORY = "packages/db/self-hosted/supabase/migrations";
const VERIFY_FILE = "packages/db/self-hosted/verify.sql";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type DbOptions = {
  mode: "provision" | "verify" | "apply";
  runtime: string;
  source: string;
};

type FileInfo = {
  directory: boolean;
  regular: boolean;
  symbolicLink: boolean;
  mode: number;
  uid: number;
  size: number;
};

export type Command = {
  executable: "docker" | "git";
  args: string[];
  input?: string;
};

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type DatabaseIO = {
  effectiveUid: number;
  fileInfo: (path: string) => FileInfo;
  canonicalPath: (path: string) => string;
  readText: (path: string) => string;
  list: (path: string) => string[];
  run: (command: Command) => CommandResult;
};

/** Only our fixed, non-secret messages may escape to the operator. */
export class DatabaseOperationError extends Error {}

function fail(message: string): never {
  throw new DatabaseOperationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail("Invalid deployment metadata; content was suppressed");
  }
}

export function parseDbOptions(args: string[]): DbOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !["--mode", "--runtime", "--source"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      values.has(flag)
    ) {
      fail("Unsupported, missing or duplicate option; use --help");
    }
    values.set(flag, value);
  }
  const mode = values.get("--mode");
  if (mode !== "provision" && mode !== "verify" && mode !== "apply") {
    fail("Select --mode provision, verify or apply");
  }
  const options: DbOptions = {
    mode,
    runtime: values.get("--runtime") ?? "",
    source: values.get("--source") ?? "",
  };
  assertOwnOptions(options);
  return options;
}

export function assertOwnOptions(options: DbOptions): void {
  if (
    !["provision", "verify", "apply"].includes(options.mode) ||
    options.runtime !== RUNTIME ||
    options.source !== SOURCE
  ) {
    fail(
      "Only the dedicated /opt/agsaas source and Supabase runtime are allowed",
    );
  }
}

export function validateDatabaseEnvironment(
  values: Record<string, string>,
): string {
  const password = values.AGSAAS_DB_PASSWORD;
  if (
    !password ||
    !/^[a-f0-9]{64}$/.test(password) ||
    values.COMPOSE_PROJECT_NAME !== PROJECT ||
    values.POOLER_TENANT_ID !== PROJECT ||
    values.AGSAAS_SOURCE_DIR !== SOURCE ||
    values.POSTGRES_DB !== "postgres" ||
    values.POSTGRES_PORT !== "5432" ||
    !/^[a-f0-9]{40}$/.test(values.AGSAAS_RELEASE ?? "") ||
    values.AGSAAS_DATABASE_URL !==
      `postgresql://agsaas_app:${password}@db:5432/postgres?sslmode=disable` ||
    values.AGSAAS_WORKER_DATABASE_URL !==
      `postgresql://agsaas_app.${PROJECT}:${password}@supavisor:6543/postgres?sslmode=disable`
  ) {
    fail("The private environment does not match the dedicated deployment");
  }
  return password;
}

export function validateDeploymentManifest(value: unknown): void {
  if (
    !isRecord(value) ||
    value.mode !== "private-staging" ||
    value.supabaseRelease !== SUPABASE_RELEASE ||
    value.supabaseCommit !== SUPABASE_COMMIT ||
    typeof value.applicationCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.applicationCommit) ||
    value.publicAccessEnabled !== false ||
    value.externalEmailDeliveryEnabled !== false
  ) {
    fail("The private deployment manifest does not match the pinned platform");
  }
}

export function validateContainerInspection(value: unknown): string {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    value.name !== `/${CONTAINER}` ||
    value.image !== IMAGE ||
    value.project !== PROJECT ||
    value.service !== "db" ||
    value.workingDirectory !== RUNTIME ||
    value.running !== true ||
    value.health !== "healthy" ||
    !Array.isArray(value.mounts)
  ) {
    fail("The database container is not the healthy, dedicated pinned service");
  }
  const dataMounts = value.mounts.filter(
    (mount: unknown) =>
      isRecord(mount) && mount.Destination === "/var/lib/postgresql/data",
  );
  const data = dataMounts[0];
  if (
    dataMounts.length !== 1 ||
    !isRecord(data) ||
    data.Type !== "bind" ||
    data.Source !== DATA_DIRECTORY ||
    data.RW !== true
  ) {
    fail("The database container does not use the dedicated data directory");
  }
  return value.id;
}

type SqlStatement = { start: number; end: number; code: string };

/** Recognize transaction boundaries, not semicolons inside SQL/function bodies. */
export function sqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = 0;
  let code = "";
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    if (sql.startsWith("--", index)) {
      // PostgreSQL scan.l ends a line comment at either CR or LF, not only LF.
      const nextLine = /[\r\n]/.exec(sql.slice(index + 2));
      index = nextLine ? index + 2 + nextLine.index + 1 : sql.length;
      code += " ";
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else index++;
      }
      if (depth) fail("SQL contains an unterminated comment");
      code += " ";
      continue;
    }
    const dollarTag =
      character === "$" && !/[A-Za-z0-9_$]/.test(sql[index - 1] ?? "")
        ? /^(?:\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/.exec(sql.slice(index))?.[0]
        : undefined;
    if (dollarTag) {
      const end = sql.indexOf(dollarTag, index + dollarTag.length);
      if (end === -1) fail("SQL contains an unterminated function or string");
      index = end + dollarTag.length;
      code += " quoted ";
      continue;
    }
    if (character === "'" || character === '"') {
      const escaped =
        character === "'" &&
        /[eE]/.test(sql[index - 1] ?? "") &&
        !/[A-Za-z0-9_$]/.test(sql[index - 2] ?? "");
      let closed = false;
      index++;
      while (index < sql.length) {
        if (escaped && sql[index] === "\\") index += 2;
        else if (sql[index] === character) {
          if (sql[index + 1] === character) index += 2;
          else {
            index++;
            closed = true;
            break;
          }
        } else index++;
      }
      if (!closed) fail("SQL contains an unterminated quoted value");
      code += " quoted ";
      continue;
    }
    if (character === "\\") fail("SQL must not contain psql metacommands");
    if (character === ";") {
      if (code.trim()) {
        statements.push({
          start,
          end: index + 1,
          code: code.trim().replace(/\s+/g, " ").toUpperCase(),
        });
      }
      start = index + 1;
      code = "";
    } else code += character;
    index++;
  }
  if (code.trim())
    fail("Every top-level SQL statement must end in a semicolon");
  return statements;
}

export function isTransactionControl(statement: SqlStatement): boolean {
  return /^(?:BEGIN|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|START TRANSACTION|PREPARE TRANSACTION|SET TRANSACTION)(?: |$)/.test(
    statement.code,
  );
}

export function verificationSql(baseline: string, verifier: string): string {
  const baselineStatements = sqlStatements(baseline);
  if (
    !baselineStatements.length ||
    baselineStatements.some(isTransactionControl)
  ) {
    fail("The baseline must not contain transaction controls");
  }
  const statements = sqlStatements(verifier);
  const first = statements[0];
  const last = statements.at(-1);
  if (
    statements.length < 3 ||
    first?.code !== "BEGIN" ||
    last?.code !== "ROLLBACK" ||
    statements.slice(1, -1).some(isTransactionControl)
  ) {
    fail("The verifier must have exactly one outer BEGIN and final ROLLBACK");
  }
  // Preserve newlines so diagnostics can be mapped to the reviewed source.
  const blank = (text: string) => text.replace(/[^\r\n]/g, " ");
  const body =
    blank(verifier.slice(0, first.end)) +
    verifier.slice(first.end, last.start) +
    blank(verifier.slice(last.start));
  return `BEGIN;\n${baseline}\n${body}\nROLLBACK;\n`;
}

/** PostgreSQL accepts an already encrypted SCRAM secret without rehashing it. */
export function scramVerifier(
  password: string,
  salt = randomBytes(16),
): string {
  if (!/^[a-f0-9]{64}$/.test(password) || salt.length !== 16) {
    fail(
      "The backend credential must be a generated 32-byte hexadecimal secret",
    );
  }
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(client).digest("base64");
  const server = createHmac("sha256", salted)
    .update("Server Key")
    .digest("base64");
  salted.fill(0);
  client.fill(0);
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
}

export function provisioningSql(password: string): string {
  const encrypted = scramVerifier(password);
  return `DO $role_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agsaas_app') THEN
    RAISE EXCEPTION 'The application role already exists; refusing credential rotation' USING ERRCODE = '42710';
  END IF;
END;
$role_guard$;
CREATE ROLE agsaas_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD '${encrypted}';
GRANT CONNECT ON DATABASE postgres TO agsaas_app;
`;
}

/**
 * Exact history shape and INSERT (never UPSERT) from Supabase CLI v2.84.6:
 * https://github.com/supabase/cli/blob/v2.84.6/pkg/migration/history.go
 * File version/name and statement metadata follow migration/file.go and
 * parser/token.go: trim the terminating semicolon, then surrounding whitespace,
 * preserving comments and function bodies. This is the one reviewed baseline,
 * not a replacement for the CLI's general incremental-migration parser.
 */
export function baselineHistorySql(
  baseline: string,
  filename: string,
  sourceCommit: string,
): string {
  const matched = /^(\d{14})_(application_baseline)\.sql$/.exec(filename);
  if (!matched || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    fail(
      "Only a reviewed baseline filename and source revision may be recorded",
    );
  }
  const parsed = sqlStatements(baseline);
  if (!parsed.length || parsed.some(isTransactionControl)) {
    fail("Cannot register a baseline with transaction controls");
  }
  const statements = parsed.map((statement) =>
    baseline.slice(statement.start, statement.end).replace(/;+$/, "").trim(),
  );
  const trailingComment = baseline.slice(parsed.at(-1)!.end).trim();
  if (trailingComment) statements.push(trailingComment);
  const digest = createHash("sha256").update(baseline).digest("hex");
  // Base64 is only transport encoding, not a secret. It avoids SQL-literal
  // escaping ambiguity while preserving the exact original UTF-8 statements.
  const encoded = statements.map(
    (statement) =>
      `convert_from(decode('${Buffer.from(statement).toString("base64")}', 'base64'), 'UTF8')`,
  );
  return `SET LOCAL lock_timeout = '4s';
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;
INSERT INTO supabase_migrations.schema_migrations(version, name, statements)
VALUES ('${matched[1]}', '${matched[2]}', ARRAY[${encoded.join(",\n")}]);
REVOKE ALL ON supabase_migrations.schema_migrations FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
CREATE TABLE private.agsaas_baseline_installation (
  version text PRIMARY KEY REFERENCES supabase_migrations.schema_migrations(version),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  source_commit text NOT NULL CHECK (source_commit ~ '^[a-f0-9]{40}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.agsaas_baseline_installation FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
INSERT INTO private.agsaas_baseline_installation(version, sha256, source_commit)
VALUES ('${matched[1]}', '${digest}', '${sourceCommit}');
`;
}

/** Do not forward PostgreSQL text, echoed SQL, connection strings or causes. */
export function summarizePsqlFailure(result: CommandResult): string {
  const match =
    /^psql:(?:<stdin>|-):(\d{1,8}): (?:ERROR|FATAL):\s+([0-9A-Z]{5})\s*$/m.exec(
      result.stderr,
    );
  const detail = match ? `; SQLSTATE ${match[2]}; stdin line ${match[1]}` : "";
  const status =
    result.status !== null && Number.isInteger(result.status)
      ? `exit ${result.status}`
      : "process did not complete";
  return `Database operation failed (${status}${detail}); SQL and private output were suppressed. Inspect the database outcome before retrying`;
}

function directory(io: DatabaseIO, path: string): FileInfo {
  const info = io.fileInfo(path);
  if (
    !info.directory ||
    info.symbolicLink ||
    (info.mode & 0o022) !== 0 ||
    io.canonicalPath(path) !== path
  ) {
    fail(
      "Deployment directories must be canonical and not writable by other users",
    );
  }
  return info;
}

function file(
  io: DatabaseIO,
  path: string,
  privateOwners?: ReadonlySet<number>,
): string {
  const info = io.fileInfo(path);
  if (
    !info.regular ||
    info.symbolicLink ||
    info.size < 1 ||
    info.size > MAX_FILE_BYTES ||
    (info.mode & 0o022) !== 0 ||
    io.canonicalPath(path) !== path ||
    (privateOwners &&
      ((info.mode & 0o777) !== 0o600 || !privateOwners.has(info.uid)))
  ) {
    fail(
      "Deployment files must be safe regular files; private files require mode 0600 and an authorized owner",
    );
  }
  return io.readText(path);
}

function run(io: DatabaseIO, command: Command, phase: string): CommandResult {
  let result: CommandResult;
  try {
    result = io.run(command);
  } catch {
    return fail(`${phase} failed; private process details were suppressed`);
  }
  if (result.status !== 0) {
    fail(
      phase === "PostgreSQL"
        ? summarizePsqlFailure(result)
        : `${phase} failed; private process details were suppressed`,
    );
  }
  return result;
}

function git(io: DatabaseIO, ...args: string[]): string {
  return run(
    io,
    {
      executable: "git",
      args: [
        "--no-optional-locks",
        "-c",
        `safe.directory=${SOURCE}`,
        "-c",
        "core.fsmonitor=false",
        "-C",
        SOURCE,
        ...args,
      ],
    },
    "Source verification",
  ).stdout.trim();
}

const INSPECT_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDirectory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}}}';

function psql(
  io: DatabaseIO,
  id: string,
  input: string,
  atomic: boolean,
): void {
  run(
    io,
    {
      executable: "docker",
      args: [
        "--host",
        DOCKER_HOST,
        "exec",
        "-i",
        "--user",
        "postgres",
        "--env",
        "PGCONNECT_TIMEOUT=5",
        "--env",
        "PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=4000 -c transaction_timeout=45000 -c idle_in_transaction_session_timeout=45000",
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
    },
    "PostgreSQL",
  );
}

export function runDatabaseOperation(options: DbOptions, io: DatabaseIO) {
  try {
    assertOwnOptions(options);
    const sourceInfo = directory(io, SOURCE);
    const runtimeInfo = directory(io, RUNTIME);
    directory(io, DATA_DIRECTORY);
    // sudo is needed for Docker, but preparation may belong to the deployment
    // operator. Root may read that validated directory owner's private files;
    // an ordinary user does not gain permission to accept arbitrary owners.
    const privateOwners = new Set([0, io.effectiveUid]);
    if (io.effectiveUid === 0) {
      privateOwners.add(sourceInfo.uid);
      privateOwners.add(runtimeInfo.uid);
    }
    let environment: Record<string, string>;
    try {
      environment = parseEnvironment(
        file(io, join(RUNTIME, ".env"), privateOwners),
      );
    } catch (error) {
      if (error instanceof DatabaseOperationError) throw error;
      return fail("Invalid private environment; content was suppressed");
    }
    const password = validateDatabaseEnvironment(environment);
    validateDeploymentManifest(
      parseJson(
        file(io, join(RUNTIME, "deployment-manifest.json"), privateOwners),
      ),
    );
    if (git(io, "status", "--porcelain", "--untracked-files=all")) {
      fail("The application source must be a clean reviewed Git checkout");
    }
    const sourceCommit = git(io, "rev-parse", "--verify", "HEAD");
    if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("Invalid source revision");
    const inspected = run(
      io,
      {
        executable: "docker",
        args: [
          "--host",
          DOCKER_HOST,
          "inspect",
          "--format",
          INSPECT_FORMAT,
          CONTAINER,
        ],
      },
      "Database identity verification",
    );
    const id = validateContainerInspection(parseJson(inspected.stdout));
    if (options.mode === "provision") {
      psql(io, id, provisioningSql(password), true);
      return {
        mode: options.mode,
        project: PROJECT,
        container: CONTAINER,
        sourceCommit,
      };
    }
    const migrationDirectory = join(SOURCE, BASELINE_DIRECTORY);
    directory(io, migrationDirectory);
    const entries = io.list(migrationDirectory);
    const migrations = entries.filter((name) => name.endsWith(".sql"));
    const migration = migrations[0];
    if (
      migrations.length !== 1 ||
      !migration ||
      !/^\d{14}_application_baseline\.sql$/.test(migration)
    ) {
      fail(
        "This one-time helper requires exactly one application baseline migration",
      );
    }
    git(
      io,
      "ls-files",
      "--error-unmatch",
      "--",
      `${BASELINE_DIRECTORY}/${migration}`,
      VERIFY_FILE,
    );
    const baseline = file(io, join(migrationDirectory, migration));
    const verifier = file(io, join(SOURCE, VERIFY_FILE));
    const baselineSha256 = createHash("sha256").update(baseline).digest("hex");
    const verification = verificationSql(baseline, verifier);
    psql(io, id, verification, false);
    if (options.mode === "apply") {
      // Both calls use the same already-read SQL. A failed verification cannot
      // reach this mutation. ON_ERROR_STOP + --single-transaction commits the
      // application DDL, CLI history and private checksum record together.
      const history = baselineHistorySql(baseline, migration, sourceCommit);
      psql(io, id, `${baseline}\n${history}`, true);
    }
    return {
      mode: options.mode,
      project: PROJECT,
      container: CONTAINER,
      sourceCommit,
      baseline: migration,
      baselineSha256,
      rolledBack: options.mode === "verify",
      migrationHistoryRecorded: options.mode === "apply",
    };
  } catch (error) {
    if (error instanceof DatabaseOperationError) throw error;
    return fail(
      "Deployment validation failed; private filesystem and process details were suppressed",
    );
  }
}

const localIO: DatabaseIO = {
  effectiveUid: process.geteuid?.() ?? -1,
  fileInfo(path) {
    const stat = lstatSync(path);
    return {
      directory: stat.isDirectory(),
      regular: stat.isFile(),
      symbolicLink: stat.isSymbolicLink(),
      mode: stat.mode,
      uid: stat.uid,
      size: stat.size,
    };
  },
  canonicalPath: realpathSync,
  readText(path) {
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        fail("Unsafe deployment file");
      return readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  },
  list: readdirSync,
  run(command) {
    const result = spawnSync(command.executable, command.args, {
      input: command.input,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

function main(): void {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    writeSync(
      1,
      "Usage: node scripts/self-hosted-db.mts --mode provision|verify|apply --runtime /opt/agsaas/runtime/supabase --source /opt/agsaas/source\n" +
        "Dedicated local deployment only. No remote Docker, reset, credential rotation or SQL-output mode.\n" +
        "Provision once, verify with rollback, then apply atomically after repeating verification.\n",
    );
    return;
  }
  try {
    const result = runDatabaseOperation(
      parseDbOptions(process.argv.slice(2)),
      localIO,
    );
    writeSync(1, `${JSON.stringify(result)}\n`);
  } catch (error) {
    writeSync(
      2,
      `${
        error instanceof DatabaseOperationError
          ? error.message
          : "Database operation failed; private details were suppressed"
      }\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
