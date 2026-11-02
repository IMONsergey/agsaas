import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SUPABASE_COMMIT,
  SUPABASE_RELEASE,
  serializeEnvironment,
} from "./prepare-self-hosted.mts";
import {
  baselineHistorySql,
  type Command,
  type CommandResult,
  type DatabaseIO,
  type DbOptions,
  parseDbOptions,
  provisioningSql,
  runDatabaseOperation,
  scramVerifier,
  sqlStatements,
  summarizePsqlFailure,
  validateContainerInspection,
  validateDatabaseEnvironment,
  validateDeploymentManifest,
  verificationSql,
} from "./self-hosted-db.mts";

const runtime = "/opt/agsaas/runtime/supabase";
const source = "/opt/agsaas/source";
const password = "a".repeat(64);
const commit = "b".repeat(40);
const containerId = "c".repeat(64);
const migration = "20261031154237_application_baseline.sql";
const migrationDirectory = `${source}/packages/db/self-hosted/supabase/migrations`;
const verifyPath = `${source}/packages/db/self-hosted/verify.sql`;
const baseline = "CREATE TABLE public.application_fixture (id uuid);\n";
const verifier = "-- Header\nBEGIN;\nSELECT true;\nROLLBACK;\n";

function environmentFixture(): Record<string, string> {
  return {
    AGSAAS_DB_PASSWORD: password,
    AGSAAS_SOURCE_DIR: source,
    AGSAAS_RELEASE: commit,
    COMPOSE_PROJECT_NAME: "agsaas-stage",
    POOLER_TENANT_ID: "agsaas-stage",
    POSTGRES_DB: "postgres",
    POSTGRES_PORT: "5432",
    AGSAAS_DATABASE_URL: `postgresql://agsaas_app:${password}@db:5432/postgres?sslmode=disable`,
    AGSAAS_WORKER_DATABASE_URL: `postgresql://agsaas_app.agsaas-stage:${password}@supavisor:6543/postgres?sslmode=disable`,
  };
}

function manifestFixture() {
  return {
    mode: "private-staging",
    supabaseRelease: SUPABASE_RELEASE,
    supabaseCommit: SUPABASE_COMMIT,
    applicationCommit: "d".repeat(40),
    publicAccessEnabled: false,
    externalEmailDeliveryEnabled: false,
  };
}

function inspectionFixture() {
  return {
    id: containerId,
    name: "/agsaas-stage-db",
    image: "supabase/postgres:17.6.1.136",
    project: "agsaas-stage",
    service: "db",
    workingDirectory: runtime,
    running: true,
    health: "healthy",
    mounts: [
      {
        Type: "bind",
        Source: `${runtime}/volumes/db/data`,
        Destination: "/var/lib/postgresql/data",
        RW: true,
      },
    ],
  };
}

const options = (mode: DbOptions["mode"]): DbOptions => ({
  mode,
  runtime,
  source,
});
const success = (stdout = ""): CommandResult => ({
  status: 0,
  stdout,
  stderr: "",
});

function ioFixture() {
  const files = new Map([
    [`${runtime}/.env`, serializeEnvironment(environmentFixture())],
    [`${runtime}/deployment-manifest.json`, JSON.stringify(manifestFixture())],
    [`${migrationDirectory}/${migration}`, baseline],
    [verifyPath, verifier],
  ]);
  const commands: Command[] = [];
  const io: DatabaseIO = {
    effectiveUid: 0,
    fileInfo(path) {
      const contents = files.get(path);
      return {
        directory: contents === undefined,
        regular: contents !== undefined,
        symbolicLink: false,
        mode:
          contents === undefined
            ? 0o755
            : path.startsWith(runtime)
              ? 0o600
              : 0o644,
        uid: 0,
        size: contents?.length ?? 4096,
      };
    },
    canonicalPath: (path) => path,
    readText(path) {
      const contents = files.get(path);
      if (contents === undefined) throw new Error("Unexpected fixture file");
      return contents;
    },
    list: () => [migration],
    run(command) {
      commands.push(command);
      if (command.executable === "git") {
        return success(command.args.includes("rev-parse") ? commit : "");
      }
      if (command.args.includes("inspect"))
        return success(JSON.stringify(inspectionFixture()));
      return success();
    },
  };
  return { io, commands, files };
}

describe("strict deployment identity", () => {
  test("accepts only complete, unique explicit options", () => {
    const args = ["--mode", "verify", "--runtime", runtime, "--source", source];
    expect(parseDbOptions(args)).toEqual(options("verify"));
    for (const invalid of [
      args.slice(0, -2),
      [...args, "--mode", "apply"],
      [...args, "--docker-host", "tcp://other-host"],
      ["--mode", "reset", "--runtime", runtime, "--source", source],
      [
        "--mode",
        "apply",
        "--runtime",
        `${runtime}/../supabase`,
        "--source",
        source,
      ],
      ["--mode", "apply", "--runtime", "/", "--source", source],
    ]) {
      expect(() => parseDbOptions(invalid)).toThrow();
    }
  });

  test("validates generated credentials and both exact internal connection targets", () => {
    expect(validateDatabaseEnvironment(environmentFixture())).toBe(password);
    for (const [name, value] of [
      ["AGSAAS_DB_PASSWORD", "not-a-generated-secret"],
      [
        "AGSAAS_DATABASE_URL",
        `postgresql://postgres:${password}@other:5432/postgres`,
      ],
      [
        "AGSAAS_WORKER_DATABASE_URL",
        `postgresql://agsaas_app:${password}@db:5432/postgres`,
      ],
      ["COMPOSE_PROJECT_NAME", "supabase"],
      ["POOLER_TENANT_ID", "other"],
      ["POSTGRES_DB", "production"],
      ["POSTGRES_PORT", "5433"],
      ["AGSAAS_SOURCE_DIR", "/opt/other"],
      ["AGSAAS_RELEASE", "main"],
    ]) {
      expect(() =>
        validateDatabaseEnvironment({
          ...environmentFixture(),
          [name!]: value!,
        }),
      ).toThrow("dedicated deployment");
    }
  });

  test("rejects a different platform or public deployment manifest", () => {
    expect(() => validateDeploymentManifest(manifestFixture())).not.toThrow();
    for (const changed of [
      null,
      { ...manifestFixture(), supabaseCommit: "e".repeat(40) },
      { ...manifestFixture(), supabaseRelease: "latest" },
      { ...manifestFixture(), publicAccessEnabled: true },
      { ...manifestFixture(), externalEmailDeliveryEnabled: true },
    ]) {
      expect(() => validateDeploymentManifest(changed)).toThrow(
        "pinned platform",
      );
    }
  });

  test("validates container ID, image, compose labels, health and the exact data bind", () => {
    expect(validateContainerInspection(inspectionFixture())).toBe(containerId);
    for (const changed of [
      { ...inspectionFixture(), name: "/other-db" },
      { ...inspectionFixture(), id: "agsaas-stage-db" },
      { ...inspectionFixture(), image: "postgres:17" },
      { ...inspectionFixture(), project: "supabase" },
      { ...inspectionFixture(), service: "worker" },
      { ...inspectionFixture(), workingDirectory: "/opt/other" },
      { ...inspectionFixture(), running: false },
      { ...inspectionFixture(), health: "starting" },
      { ...inspectionFixture(), mounts: [] },
      {
        ...inspectionFixture(),
        mounts: inspectionFixture().mounts.map((mount) => ({
          ...mount,
          Source: "/other/data",
        })),
      },
      {
        ...inspectionFixture(),
        mounts: inspectionFixture().mounts.map((mount) => ({
          ...mount,
          RW: false,
        })),
      },
      {
        ...inspectionFixture(),
        mounts: [...inspectionFixture().mounts, ...inspectionFixture().mounts],
      },
    ]) {
      expect(() => validateContainerInspection(changed)).toThrow();
    }
  });

  test("refuses non-private, foreign-owned or symlinked environment before any command", () => {
    for (const change of [
      { mode: 0o644 },
      { mode: 0o660 },
      { uid: 1001 },
      { symbolicLink: true },
      { regular: false },
      { size: 0 },
      { size: 3 * 1024 * 1024 },
    ]) {
      const { io, commands } = ioFixture();
      const original = io.fileInfo;
      io.fileInfo = (path) => ({
        ...original(path),
        ...(path.endsWith("/.env") ? change : {}),
      });
      expect(() => runDatabaseOperation(options("provision"), io)).toThrow(
        "safe regular files",
      );
      expect(commands).toEqual([]);
    }
  });

  test("refuses symlinked or other-writable runtime/source/data directories", () => {
    for (const path of [source, runtime, `${runtime}/volumes/db/data`]) {
      const { io, commands } = ioFixture();
      io.canonicalPath = (candidate) =>
        candidate === path ? "/somewhere/else" : candidate;
      expect(() => runDatabaseOperation(options("provision"), io)).toThrow(
        "canonical",
      );
      expect(commands).toEqual([]);
    }
    const { io } = ioFixture();
    const original = io.fileInfo;
    io.fileInfo = (path) => ({ ...original(path), mode: 0o777 });
    expect(() => runDatabaseOperation(options("provision"), io)).toThrow(
      "not writable",
    );
  });

  test("sudo accepts the validated deployment owner's private files, not unrelated owners", () => {
    const { io } = ioFixture();
    const original = io.fileInfo;
    io.fileInfo = (path) => ({
      ...original(path),
      uid: path.startsWith(runtime) || path === source ? 1000 : 0,
    });
    expect(() => runDatabaseOperation(options("provision"), io)).not.toThrow();
    io.effectiveUid = 1002;
    expect(() => runDatabaseOperation(options("provision"), io)).toThrow(
      "authorized owner",
    );
    io.effectiveUid = 0;
    io.fileInfo = (path) => ({
      ...original(path),
      uid: path.endsWith("/.env") ? 1001 : 1000,
    });
    expect(() => runDatabaseOperation(options("provision"), io)).toThrow(
      "authorized owner",
    );
  });

  test("rejects a dirty source without leaking sensitive filenames", () => {
    const { io, commands } = ioFixture();
    io.run = (command) => {
      commands.push(command);
      return success(`?? private-${password}.env`);
    };
    expect(() => runDatabaseOperation(options("verify"), io)).toThrow(
      "clean reviewed",
    );
    expect(commands.every((command) => command.executable === "git")).toBe(
      true,
    );
  });

  test("rejects extra migrations rather than treating this as a generic upgrade tool", () => {
    const { io, commands } = ioFixture();
    io.list = () => [migration, "20261101000000_followup.sql"];
    expect(() => runDatabaseOperation(options("verify"), io)).toThrow(
      "exactly one",
    );
    expect(commands.some((command) => command.args.includes("exec"))).toBe(
      false,
    );
  });
});

describe("transaction-safe SQL composition", () => {
  test("ignores transaction-looking strings, nested comments and dollar-quoted bodies", () => {
    const sql = `-- BEGIN;\n/* nested /* ROLLBACK; */ comment */
CREATE FUNCTION sample() RETURNS void LANGUAGE plpgsql AS $body$
BEGIN PERFORM 'ROLLBACK;'; END; $body$;
SELECT 'COMMIT; it''s data', "BEGIN", E'escaped\\'quote;';`;
    expect(sqlStatements(sql).map((statement) => statement.code)).toEqual([
      "CREATE FUNCTION SAMPLE() RETURNS VOID LANGUAGE PLPGSQL AS QUOTED",
      "SELECT QUOTED , QUOTED , E QUOTED",
    ]);
    const combined = verificationSql(sql, verifier);
    const statements = sqlStatements(combined);
    expect(statements[0]?.code).toBe("BEGIN");
    expect(statements.at(-1)?.code).toBe("ROLLBACK");
    expect(
      statements.filter((statement) => statement.code === "BEGIN"),
    ).toHaveLength(1);
    expect(
      statements.filter((statement) => statement.code === "ROLLBACK"),
    ).toHaveLength(1);
    expect(combined).toContain(sql);
  });

  test("the real reviewed baseline/verifier form one rollback-only transaction", () => {
    const base = readFileSync(
      join(
        __dirname,
        "../packages/db/self-hosted/supabase/migrations",
        migration,
      ),
      "utf8",
    );
    const verify = readFileSync(
      join(__dirname, "../packages/db/self-hosted/verify.sql"),
      "utf8",
    );
    const combined = verificationSql(base, verify);
    const statements = sqlStatements(combined);
    expect(statements[0]?.code).toBe("BEGIN");
    expect(statements.at(-1)?.code).toBe("ROLLBACK");
    expect(
      statements
        .filter((statement) => /^(BEGIN|ROLLBACK|COMMIT)$/.test(statement.code))
        .map((statement) => statement.code),
    ).toEqual(["BEGIN", "ROLLBACK"]);
    expect(combined).toContain(base);
    expect(combined).toContain("Auth insert synchronously creates profiles");
  });

  test("refuses any extra transaction controls or changed verifier wrapper", () => {
    for (const invalid of [
      "SELECT true;",
      "BEGIN; SELECT true; COMMIT;",
      "BEGIN; BEGIN; SELECT true; ROLLBACK;",
      "BEGIN; SELECT true; ROLLBACK; SELECT true;",
      "BEGIN; SAVEPOINT extra; SELECT true; ROLLBACK;",
      "BEGIN; ROLLBACK;",
      "START TRANSACTION; SELECT true; ROLLBACK;",
    ]) {
      expect(() => verificationSql(baseline, invalid)).toThrow(
        "exactly one outer",
      );
    }
    for (const control of [
      "BEGIN",
      "COMMIT",
      "END",
      "ROLLBACK",
      "ABORT",
      "SAVEPOINT extra",
      "PREPARE TRANSACTION 'x'",
      "SET TRANSACTION READ ONLY",
    ]) {
      expect(() => verificationSql(`${baseline}${control};`, verifier)).toThrow(
        "transaction controls",
      );
    }
  });

  test("rejects psql metacommands, truncated statements and unterminated syntax", () => {
    for (const sql of [
      "\\include /private/secrets\n",
      "SELECT true; \\! echo bad\n",
      "SELECT true",
      "SELECT 'unterminated;",
      'SELECT "unterminated;',
      "SELECT $quote$unterminated;",
      "/* unterminated comment",
    ]) {
      expect(() => sqlStatements(sql)).toThrow();
    }
  });

  test("CR-only and CRLF comments cannot conceal a transaction control", () => {
    for (const ending of ["\r", "\n", "\r\n"]) {
      const disguised = `SELECT true; -- harmless-looking comment${ending}COMMIT;`;
      expect(sqlStatements(disguised).at(-1)?.code).toBe("COMMIT");
      expect(() => verificationSql(disguised, verifier)).toThrow(
        "transaction controls",
      );
    }
  });
});

describe("backend credential provisioning", () => {
  test("matches the fixed ASCII credential fixture and independent WebCrypto SCRAM keys", async () => {
    const salt = Buffer.alloc(16, 1);
    const encrypted = scramVerifier(password, salt);
    expect(encrypted).toBe(
      "SCRAM-SHA-256$4096:AQEBAQEBAQEBAQEBAQEBAQ==$b3Aop8XixJeSsvZuWz5Tfyp0f1/GsxruewqF6Ol3/l8=:LtjwULx1fSNe2tXPUmJsA1LnB7tyZ6yNraOGse876sM=",
    );
    const key = await webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await webcrypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 4096 },
      key,
      256,
    );
    const hmacKey = await webcrypto.subtle.importKey(
      "raw",
      bits,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const clientKey = await webcrypto.subtle.sign(
      "HMAC",
      hmacKey,
      new TextEncoder().encode("Client Key"),
    );
    const storedKey = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", clientKey),
    ).toString("base64");
    const serverKey = Buffer.from(
      await webcrypto.subtle.sign(
        "HMAC",
        hmacKey,
        new TextEncoder().encode("Server Key"),
      ),
    ).toString("base64");
    expect(encrypted).toBe(
      `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`,
    );
  });

  test("uses fresh salts, rejects unexpected credentials and never embeds plaintext", () => {
    expect(scramVerifier(password)).not.toBe(scramVerifier(password));
    for (const bad of [
      "",
      "a".repeat(63),
      "A".repeat(64),
      "a'b",
      "unicode-é",
    ]) {
      expect(() => scramVerifier(bad)).toThrow("generated");
    }
    const sql = provisioningSql(password);
    expect(sql).not.toContain(password);
    expect(sql).toContain("SCRAM-SHA-256$4096:");
    expect(sql).toContain(
      "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION",
    );
    expect(sql).toContain("ERRCODE = '42710'");
    expect(sql).not.toContain("ALTER ROLE");
    expect(sql).not.toContain("DROP");
    expect(sqlStatements(sql)).toHaveLength(3);
  });

  test("provisions only through stdin in one transaction with an existing-role guard", () => {
    const { io, commands } = ioFixture();
    const result = runDatabaseOperation(options("provision"), io);
    const command = commands.find((command) => command.args.includes("exec"));
    expect(command?.args).toContain(containerId);
    expect(command?.args).not.toContain("agsaas-stage-db");
    expect(command?.args).toContain("--single-transaction");
    expect(command?.args).toContain("--no-password");
    expect(command?.args).toContain("--no-psqlrc");
    expect(command?.args).toContain("ON_ERROR_STOP=1");
    expect(command?.args).toContain("VERBOSITY=sqlstate");
    expect(command?.args).toContain("supabase_admin");
    expect(command?.args).toContain("PGCONNECT_TIMEOUT=5");
    expect(command?.args.join(" ")).toContain("transaction_timeout=45000");
    expect(command?.input).toContain("refusing credential rotation");
    expect(JSON.stringify(commands)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain("SCRAM");
    expect(result.sourceCommit).toBe(commit);
    const inspect = commands.find((command) =>
      command.args.includes("inspect"),
    );
    expect(inspect?.args).toContain("unix:///var/run/docker.sock");
    expect(inspect?.args.join(" ")).not.toContain(".Config.Env");
  });
});

describe("failure redaction and operation ordering", () => {
  test("records the pinned CLI version/name/statements shape and an operator-only checksum", () => {
    const original = `-- Leading comment\nCREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM ';'; END; $body$ LANGUAGE plpgsql;\n-- final comment\n`;
    const history = baselineHistorySql(original, migration, commit);
    expect(history).toContain(
      "schema_migrations (version text NOT NULL PRIMARY KEY)",
    );
    expect(history).toContain("ADD COLUMN IF NOT EXISTS statements text[]");
    expect(history).toContain("ADD COLUMN IF NOT EXISTS name text");
    expect(history).toContain(
      "VALUES ('20261031154237', 'application_baseline', ARRAY[",
    );
    const statements = [
      ...history.matchAll(/convert_from\(decode\('([A-Za-z0-9+/=]+)'/g),
    ].map((match) => Buffer.from(match[1]!, "base64").toString("utf8"));
    expect(statements).toEqual([
      "-- Leading comment\nCREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM ';'; END; $body$ LANGUAGE plpgsql",
      "-- final comment",
    ]);
    expect(history).toContain(
      "REFERENCES supabase_migrations.schema_migrations(version)",
    );
    expect(history).toContain(
      "REVOKE ALL ON private.agsaas_baseline_installation FROM PUBLIC, anon, authenticated, service_role, agsaas_app",
    );
    expect(history).not.toMatch(/ON CONFLICT|UPDATE |DELETE |DROP /);
    expect(() => baselineHistorySql(baseline, "123_other.sql", commit)).toThrow(
      "reviewed baseline",
    );
    expect(() => baselineHistorySql(baseline, migration, "unreviewed")).toThrow(
      "source revision",
    );
  });

  test("retains only a bounded SQLSTATE and stdin line, never SQL/error contents", () => {
    const result = {
      status: 3,
      stdout: password,
      stderr: `NOTICE: ${password}\npsql:<stdin>:123: ERROR: 42P01\nLINE 1: SELECT '${password}';\n`,
    };
    expect(summarizePsqlFailure(result)).toContain(
      "SQLSTATE 42P01; stdin line 123",
    );
    expect(summarizePsqlFailure(result)).not.toContain(password);
    for (const stderr of [
      `psql:<stdin>:12: ERROR: 42P01 ${password}`,
      `psql:/private/${password}.sql:12: ERROR: 42P01`,
      `psql:<stdin>:123456789012: ERROR: 42P01`,
      `psql: error: connection failed: ${password}`,
    ]) {
      expect(
        summarizePsqlFailure({ status: null, stdout: "", stderr }),
      ).not.toContain(password);
      expect(
        summarizePsqlFailure({ status: null, stdout: "", stderr }),
      ).not.toContain("SQLSTATE");
    }
  });

  test("malformed private JSON/env and thrown child failures never disclose input", () => {
    for (const path of [
      `${runtime}/.env`,
      `${runtime}/deployment-manifest.json`,
    ]) {
      const { io, files } = ioFixture();
      files.set(path, `${password} malformed private value`);
      try {
        runDatabaseOperation(options("provision"), io);
        throw new Error("Expected operation to fail");
      } catch (error) {
        expect(String(error)).not.toContain(password);
        expect(String(error)).toContain("suppressed");
      }
    }
    const { io } = ioFixture();
    io.run = () => {
      throw new Error(`private command: ${password}`);
    };
    expect(() => runDatabaseOperation(options("provision"), io)).toThrow(
      "private process details were suppressed",
    );
  });

  test("verify executes only the rollback transaction and reports a non-secret digest", () => {
    const { io, commands } = ioFixture();
    const result = runDatabaseOperation(options("verify"), io);
    const sqlCommands = commands.filter((command) =>
      command.args.includes("exec"),
    );
    expect(sqlCommands).toHaveLength(1);
    expect(sqlCommands[0]?.input).toBe(verificationSql(baseline, verifier));
    expect(sqlCommands[0]?.args).not.toContain("--single-transaction");
    expect(result).toMatchObject({
      mode: "verify",
      rolledBack: true,
      baseline: migration,
    });
    expect("baselineSha256" in result && result.baselineSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(JSON.stringify(result)).not.toContain(password);
  });

  test("apply stops immediately if its mandatory rollback verification fails", () => {
    const { io, commands } = ioFixture();
    const original = io.run;
    io.run = (command) => {
      const result = original(command);
      return command.args.includes("exec")
        ? {
            status: 3,
            stdout: password,
            stderr: `psql:<stdin>:78: ERROR: P0001\n${password}`,
          }
        : result;
    };
    expect(() => runDatabaseOperation(options("apply"), io)).toThrow(
      "SQLSTATE P0001; stdin line 78",
    );
    expect(
      commands.filter((command) => command.args.includes("exec")),
    ).toHaveLength(1);
  });

  test("apply verifies first, then commits unchanged DDL, CLI history and checksum atomically", () => {
    const { io, commands } = ioFixture();
    const result = runDatabaseOperation(options("apply"), io);
    const sqlCommands = commands.filter((command) =>
      command.args.includes("exec"),
    );
    expect(sqlCommands).toHaveLength(2);
    expect(sqlCommands[0]?.input).toBe(verificationSql(baseline, verifier));
    expect(sqlCommands[0]?.args).not.toContain("--single-transaction");
    expect(sqlCommands[1]?.input).toBe(
      `${baseline}\n${baselineHistorySql(baseline, migration, commit)}`,
    );
    expect(sqlCommands[1]?.args).toContain("--single-transaction");
    expect(sqlCommands[1]?.args).toContain("ON_ERROR_STOP=1");
    expect(sqlCommands[1]?.args).toContain("supabase_admin");
    expect(
      sqlCommands[1]?.input?.indexOf("CREATE TABLE public.application_fixture"),
    ).toBeLessThan(
      sqlCommands[1]?.input?.indexOf(
        "INSERT INTO supabase_migrations.schema_migrations",
      ) ?? 0,
    );
    expect(result).toMatchObject({
      mode: "apply",
      rolledBack: false,
      migrationHistoryRecorded: true,
    });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(
      commands.some((command) => command.args.includes("--error-unmatch")),
    ).toBe(true);
  });

  test("an atomic apply/history failure is returned, never silently marked or retried", () => {
    const { io, commands } = ioFixture();
    const original = io.run;
    io.run = (command) => {
      const result = original(command);
      return command.input?.includes(
        "INSERT INTO supabase_migrations.schema_migrations",
      )
        ? {
            status: 3,
            stdout: password,
            stderr: "psql:<stdin>:98: ERROR: 23505\n",
          }
        : result;
    };
    expect(() => runDatabaseOperation(options("apply"), io)).toThrow(
      "SQLSTATE 23505; stdin line 98",
    );
    expect(
      commands.filter((command) => command.args.includes("exec")),
    ).toHaveLength(2);
  });

  test("Node 24 can run help without credentials, Docker or an initialized runtime", () => {
    const result = spawnSync(
      "node",
      [join(__dirname, "self-hosted-db.mts"), "--help"],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--mode provision|verify|apply");
    expect(result.stderr).toBe("");
  });

  test("Node CLI rejects unsupported private arguments without echoing them", () => {
    const result = spawnSync(
      "node",
      [join(__dirname, "self-hosted-db.mts"), "--password", password],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(password);
    expect(result.stderr).toContain("Unsupported");
  });
});
