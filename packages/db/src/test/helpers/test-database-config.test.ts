import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  getTestDatabaseUrl,
  TestDatabaseConfigurationError,
} from "./test-database-config";

const allowed = [
  ["localhost", "postgres://postgres:postgres@localhost:5433/midday_test"],
  [
    "IPv4 loopback",
    "postgresql://postgres:postgres@127.0.0.1:5432/midday_test",
  ],
  ["IPv6 loopback", "postgresql://postgres:postgres@[::1]:5432/midday_test"],
  [
    "Compose service",
    "postgres://postgres:postgres@postgres-test:5432/midday_test",
  ],
  ["without credentials", "postgres://localhost/midday_test"],
  ["encoded credentials", "postgres://user:p%3Fa%23ss@localhost/midday_test"],
] as const;

const rejected = [
  ["HTTP", "http://localhost/midday_test"],
  ["file protocol", "file://localhost/midday_test"],
  ["remote host", "postgres://example.com/midday_test"],
  ["private network host", "postgres://10.0.0.10/midday_test"],
  ["host suffix", "postgres://localhost.example.com/midday_test"],
  ["host trailing dot", "postgres://localhost./midday_test"],
  ["other loopback address", "postgres://127.0.0.2/midday_test"],
  ["IPv4 shorthand", "postgres://127.1/midday_test"],
  ["IPv6 remote address", "postgres://[2001:db8::1]/midday_test"],
  ["missing database", "postgres://localhost"],
  ["production database", "postgres://localhost/postgres"],
  ["database suffix", "postgres://localhost/midday_test_backup"],
  ["extra database segment", "postgres://localhost/midday_test/other"],
  ["trailing slash", "postgres://localhost/midday_test/"],
  ["encoded database", "postgres://localhost/%6Didday_test"],
  ["host override query", "postgres://localhost/midday_test?host=example.com"],
  [
    "database override query",
    "postgres://localhost/midday_test?database=production",
  ],
  ["empty query", "postgres://localhost/midday_test?"],
  ["fragment", "postgres://localhost/midday_test#production"],
  ["empty fragment", "postgres://localhost/midday_test#"],
  ["leading whitespace", " postgres://localhost/midday_test"],
  ["trailing whitespace", "postgres://localhost/midday_test\n"],
  ["malformed URL", "not-a-connection-url"],
  ["empty URL", ""],
] as const;

function runIsolated(args: readonly string[], url?: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", ...args],
    cwd: resolve(__dirname, "../../.."),
    env: url === undefined ? {} : { TEST_DATABASE_URL: url },
    timeout: 5_000,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("isolated test database URL", () => {
  test.each(allowed)("accepts %s", (_label, url) => {
    expect(getTestDatabaseUrl(url)).toBe(url);
  });

  test.each(rejected)("rejects %s", (_label, url) => {
    expect(() => getTestDatabaseUrl(url)).toThrow(
      TestDatabaseConfigurationError,
    );
  });

  test("does not include URL, username or password in validation errors", () => {
    const password = "unit-password-never-log";
    const username = "unit-user-never-log";
    const url = `postgres://${username}:${password}@example.com/production`;
    let message = "";
    try {
      getTestDatabaseUrl(url);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("TEST_DATABASE_URL");
    expect(message).not.toContain(url);
    expect(message).not.toContain(username);
    expect(message).not.toContain(password);
    expect(message).not.toContain("example.com");
  });

  test.each([
    [
      "Drizzle config",
      [
        "--eval",
        'import config from "./drizzle.config.test.ts"; console.log(Boolean(config));',
      ],
    ],
    [
      "test database helper",
      [
        "--eval",
        'import { getTestDatabase } from "./src/test/helpers/test-database.ts"; getTestDatabase();',
      ],
    ],
    [
      "E2E availability guard",
      [
        "--eval",
        'import { isTestDatabaseAvailable } from "./src/test/helpers/test-database.ts"; isTestDatabaseAvailable();',
      ],
    ],
    ["setup script", ["./src/test/helpers/setup-test-database.ts"]],
  ] as const)("%s rejects an unsafe URL without disclosing it", (_label, args) => {
    const url = "postgres://unit-user:unit-password@example.com/production";
    const result = runIsolated(args, url);
    const output = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toContain("Unsafe TEST_DATABASE_URL");
    expect(output).not.toContain(url);
    expect(output).not.toContain("unit-password");
  });

  test("Drizzle config accepts a validated local URL without connecting", () => {
    const result = runIsolated(
      [
        "--eval",
        'import config from "./drizzle.config.test.ts"; console.log(Boolean(config));',
      ],
      "postgres://localhost:5433/midday_test",
    );

    expect(result.exitCode).toBe(0);
  });

  test("setup refuses to run with an unset URL", () => {
    const result = runIsolated(["./src/test/helpers/setup-test-database.ts"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "set an explicit connection URL",
    );
  });

  test("E2E availability guard skips only an unset URL", () => {
    const result = runIsolated([
      "--eval",
      'import { isTestDatabaseAvailable } from "./src/test/helpers/test-database.ts"; console.log(isTestDatabaseAvailable());',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("false");
  });
});
