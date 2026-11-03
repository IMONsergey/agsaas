import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { databaseTransportTestCa } from "./fixtures/database-transport-ca";
import {
  DatabaseTransportConfigurationError,
  getDatabaseConnectionConfig,
} from "../connection-config";

const databaseUrl =
  "postgresql://fixture:unit-test-password@database.example.test:5432/transport_test";
const ca = databaseTransportTestCa;
let caFixture: string;
const environmentKeys = [
  "NODE_ENV",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGSSLROOTCERT",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "DATABASE_SSL_CA_FILE",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);
let directory: string;

beforeEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  directory = mkdtempSync(join(tmpdir(), "agsaas-db-transport-"));
  caFixture = join(directory, "fixture-ca.pem");
  writeFileSync(caFixture, ca, { mode: 0o600 });
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
});

function parsedParameters(url: string | undefined = databaseUrl): unknown {
  // The real pg.Client constructor invokes installed ConnectionParameters and
  // pg-connection-string. No connect()/query(), mocked parser or live DB here.
  const client = new Client(getDatabaseConnectionConfig(url));
  return Reflect.get(client, "connectionParameters");
}

function expectConfigurationError(operation: () => unknown) {
  try {
    operation();
    throw new Error("Expected transport configuration to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseTransportConfigurationError);
    if (!(error instanceof Error)) throw error;
    expect(error.message).not.toContain("unit-test-password");
    expect(error.message).not.toContain("database.example.test");
    expect(error.message).not.toContain(directory);
    expect(error.cause).toBeUndefined();
  }
}

describe("canonical PostgreSQL TLS through the actual pg parser", () => {
  test.each([
    "production",
    "development",
    "test",
  ])("verifies TLS by default in %s", (nodeEnvironment) => {
    process.env.NODE_ENV = nodeEnvironment;
    expect(parsedParameters()).toMatchObject({
      host: "database.example.test",
      port: 5432,
      database: "transport_test",
      ssl: { rejectUnauthorized: true },
      sslnegotiation: "postgres",
    });
  });

  test("removes the verified URL option before pg can replace the explicit SSL object", () => {
    const config = getDatabaseConnectionConfig(
      `${databaseUrl}?sslmode=verify-full&application_name=transport-fixture`,
    );
    expect(config.connectionString).not.toContain("sslmode");
    expect(new Client(config).host).toBe("database.example.test");
    expect(
      Reflect.get(new Client(config), "connectionParameters"),
    ).toMatchObject({
      ssl: { rejectUnauthorized: true },
      application_name: "transport-fixture",
    });
    expect(config.ssl).not.toHaveProperty("checkServerIdentity");
    expect(config.ssl).not.toHaveProperty("servername");
  });

  test("keeps an explicit isolated plain URL plain after canonicalization", () => {
    const url =
      "postgresql://fixture:unit-test-password@supavisor:6543/transport_test?sslmode=disable";
    const config = getDatabaseConnectionConfig(url);
    expect(config.connectionString).not.toContain("sslmode");
    expect(
      Reflect.get(new Client(config), "connectionParameters"),
    ).toMatchObject({
      host: "supavisor",
      port: 6543,
      ssl: false,
      sslnegotiation: "postgres",
    });
  });

  test.each([
    "disable",
    "no-verify",
    "prefer",
    "require",
    "verify-ca",
  ])("ambient PGSSLMODE=%s cannot change verified TLS or explicit plain mode", (mode) => {
    process.env.PGSSLMODE = mode;
    process.env.PGSSLNEGOTIATION = "direct";
    process.env.PGSSLROOTCERT = join(directory, "must-not-be-read.pem");
    expect(parsedParameters()).toMatchObject({
      ssl: { rejectUnauthorized: true },
      sslnegotiation: "postgres",
    });
    expect(parsedParameters(`${databaseUrl}?sslmode=disable`)).toMatchObject({
      ssl: false,
      sslnegotiation: "postgres",
    });
  });

  test("does not inherit insecure SSL even when a legacy caller omits the URL", () => {
    process.env.PGSSLMODE = "no-verify";
    const config = getDatabaseConnectionConfig(undefined);
    expect(config.connectionString).toBeUndefined();
    expect(
      Reflect.get(new Client(config), "connectionParameters"),
    ).toMatchObject({ ssl: { rejectUnauthorized: true } });
  });

  test("rejects the process-wide TLS verification bypass explicitly", () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    expectConfigurationError(() => getDatabaseConnectionConfig(databaseUrl));
    expectConfigurationError(() =>
      getDatabaseConnectionConfig(`${databaseUrl}?sslmode=disable`),
    );
  });

  test.each([
    "sslmode=no-verify",
    "ssl=no-verify",
    "ssl=0",
    "ssl=false",
    "ssl=true",
    "sslmode=require",
    "sslmode=prefer",
    "sslmode=verify-ca",
    "sslmode=allow",
    "sslmode=",
    "sslmode=VERIFY-FULL",
    "SSLMODE=disable",
    "sslMode=disable",
    "sslmode=disable&sslmode=verify-full",
    "sslmode=verify-full&sslmode=disable",
    "sslmode=disable&sslmode=disable",
    "sslmode=disable&ssl%6dode=verify-full",
    "uselibpqcompat=true",
    "uselibpqcompat=false",
    "useLibpqCompat=true",
    "sslmode=verify-full&uselibpqcompat=true",
    "sslnegotiation=direct",
    "sslrootcert=/does-not-exist/secret-ca.pem",
    "sslcert=/does-not-exist/client.pem",
    "sslkey=/does-not-exist/private.key",
    "sslmode=disable&sslrootcert=/does-not-exist/ca.pem",
  ])("rejects ambiguous or unsupported URL TLS controls (%s) before the pg parser", (query) => {
    expectConfigurationError(() => parsedParameters(`${databaseUrl}?${query}`));
  });

  test.each([
    "",
    "not-a-database-url",
    "https://fixture:unit-test-password@database.example.test/transport_test",
    "socket:/private/socket",
    `${databaseUrl}#sslmode=disable`,
    `${databaseUrl}\n`,
    ` ${databaseUrl}`,
  ])("rejects malformed connection strings without revealing their input", (url) => {
    expectConfigurationError(() => parsedParameters(url));
  });
});

describe("explicit operator CA bundle", () => {
  test("retains explicit verification and the supplied CA through actual pg parsing", () => {
    process.env.DATABASE_SSL_CA_FILE = caFixture;
    const config = getDatabaseConnectionConfig(
      `${databaseUrl}?sslmode=verify-full`,
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca });
    expect(parsedParameters()).toMatchObject({
      ssl: { rejectUnauthorized: true, ca },
    });
    expect(config.ssl).not.toHaveProperty("checkServerIdentity");
    expect(config.ssl).not.toHaveProperty("servername");
  });

  test("a blank CA option uses the runtime's normal trust store", () => {
    process.env.DATABASE_SSL_CA_FILE = "";
    expect(parsedParameters()).toMatchObject({
      ssl: { rejectUnauthorized: true },
    });
    expect(getDatabaseConnectionConfig(databaseUrl).ssl).not.toHaveProperty(
      "ca",
    );
  });

  test("an explicit plain connection never loads a CA file", () => {
    process.env.DATABASE_SSL_CA_FILE = join(
      directory,
      "absent-and-not-needed.pem",
    );
    expect(parsedParameters(`${databaseUrl}?sslmode=disable`)).toMatchObject({
      ssl: false,
    });
  });

  test("rejects missing, relative, directory and symlink CA paths without leaking paths", () => {
    const alias = join(directory, "ca-link.pem");
    symlinkSync(caFixture, alias);
    for (const path of [
      "relative-ca.pem",
      " ",
      join(directory, "missing.pem"),
      directory,
      alias,
      `${caFixture}\n`,
    ]) {
      process.env.DATABASE_SSL_CA_FILE = path;
      expectConfigurationError(() => getDatabaseConnectionConfig(databaseUrl));
    }
  });

  test.each([
    "",
    "not a certificate, unit-test-password",
    `${ca}\nPRIVATE-SECRET-CONTENT`,
    "-----BEGIN CERTIFICATE-----\ninvalid-base64\n-----END CERTIFICATE-----\n",
    "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
  ])("rejects malformed or mixed CA contents", (content) => {
    const path = join(directory, "invalid.pem");
    writeFileSync(path, content);
    process.env.DATABASE_SSL_CA_FILE = path;
    expectConfigurationError(() => getDatabaseConnectionConfig(databaseUrl));
  });

  test("bounds both CA bytes and certificate count", () => {
    const path = join(directory, "oversized.pem");
    process.env.DATABASE_SSL_CA_FILE = path;
    writeFileSync(path, "x".repeat(256 * 1024 + 1));
    expectConfigurationError(() => getDatabaseConnectionConfig(databaseUrl));
    writeFileSync(path, ca.repeat(65));
    expectConfigurationError(() => getDatabaseConnectionConfig(databaseUrl));
  });
});
