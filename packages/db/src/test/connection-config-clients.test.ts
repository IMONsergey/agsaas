import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { databaseTransportTestCa } from "./fixtures/database-transport-ca";

const fixture = resolve(__dirname, "fixtures/connection-client-child.ts");
const cwd = resolve(__dirname, "../..");
const prefix = "DATABASE_TRANSPORT_FIXTURE ";
const ca = databaseTransportTestCa;

type FixtureResult = {
  records: Array<{
    host: string;
    ssl: false | { rejectUnauthorized: boolean; ca?: string };
    sslnegotiation: string;
  }>;
  networkAttempts: number;
  error?: { name: string; message: string };
};

async function runFixture(
  scenario: string,
  region = "us-east4-eqdc4a",
): Promise<FixtureResult> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      fixture,
      scenario,
      region,
    ],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // The child builds only synthetic .invalid URLs. It inherits no database,
      // provider, CA, NODE_OPTIONS or ambient TLS settings from the gate host.
      env: {
        NODE_ENV: "test",
        LOG_PRETTY: "false",
        DB_POOL_EVENT_LOGGING: "false",
      },
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut || code !== 0)
      throw new Error(
        `Database transport fixture failed (exit ${code}, timeout ${timedOut}): ${stderr}\n${stdout}`,
      );
    const result = stdout.split("\n").find((line) => line.startsWith(prefix));
    if (!result)
      throw new Error("Database transport fixture returned no result");
    return JSON.parse(result.slice(prefix.length)) as FixtureResult;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

describe("real runtime database client transport wiring", () => {
  test.each([
    ["europe-west4-drams3a", "fra.database.invalid"],
    ["us-east4-eqdc4a", "iad.database.invalid"],
    ["us-west2", "sjc.database.invalid"],
  ])(
    "primary, regional replica %s, BullMQ and legacy jobs all verify TLS",
    async (region, replicaHost) => {
      const result = await runFixture("verified", region);
      expect(result.error).toBeUndefined();
      expect(result.records).toEqual(
        [
          "primary.database.invalid",
          replicaHost,
          "pooler.database.invalid",
          "pooler.database.invalid",
        ].map((host) => ({
          host,
          ssl: { rejectUnauthorized: true },
          sslnegotiation: "postgres",
        })),
      );
      expect(result.networkAttempts).toBe(0);
    },
    20_000,
  );

  test("development changes pool sizes, not TLS authentication", async () => {
    const result = await runFixture("development");
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(4);
    expect(
      result.records.every(
        (record) =>
          record.ssl !== false && record.ssl.rejectUnauthorized === true,
      ),
    ).toBe(true);
    expect(result.networkAttempts).toBe(0);
  }, 20_000);

  test("the explicit isolated plain policy is preserved for all four pools", async () => {
    const result = await runFixture("plain");
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(4);
    expect(
      result.records.every(
        (record) =>
          record.ssl === false && record.sslnegotiation === "postgres",
      ),
    ).toBe(true);
    expect(result.networkAttempts).toBe(0);
  }, 20_000);

  test("the worker's primary URL fallback also uses verified TLS", async () => {
    const result = await runFixture("worker-fallback");
    expect(result.error).toBeUndefined();
    expect(result.records.map((record) => record.host)).toEqual([
      "primary.database.invalid",
      "iad.database.invalid",
      "primary.database.invalid",
    ]);
    expect(
      result.records.every(
        (record) =>
          record.ssl !== false && record.ssl.rejectUnauthorized === true,
      ),
    ).toBe(true);
    expect(result.networkAttempts).toBe(0);
  }, 20_000);

  test("all runtime clients retain the explicit operator CA and hostname verification", async () => {
    const result = await runFixture("custom-ca");
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(4);
    for (const record of result.records)
      expect(record.ssl).toEqual({ rejectUnauthorized: true, ca });
    expect(result.networkAttempts).toBe(0);
  }, 20_000);

  test("an insecure primary URL fails before pool creation and does not expose credentials", async () => {
    const result = await runFixture("invalid-primary");
    expect(result.records).toHaveLength(0);
    expect(result.error?.name).toBe("DatabaseTransportConfigurationError");
    expect(result.error?.message).not.toContain("unit-test-password");
    expect(result.error?.message).not.toContain("primary.database.invalid");
    expect(result.networkAttempts).toBe(0);
  }, 20_000);
});
