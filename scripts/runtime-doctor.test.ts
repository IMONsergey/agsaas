import { describe, expect, test } from "bun:test";
import { inspectEnvironment } from "./runtime-doctor";

const core = {
  DATABASE_PRIMARY_URL:
    "postgres://test:test@localhost:5433/runtime_test?sslmode=disable",
  DATABASE_PRIMARY_POOLER_URL:
    "postgres://test:test@localhost:5433/runtime_test?sslmode=disable",
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SECRET_KEY: "sb_secret_test-only-key",
  INTERNAL_API_KEY: "internal-test-only-key",
  API_INTERNAL_URL: "http://api:8080",
  REDIS_URL: "redis://localhost:6380/1",
  REDIS_QUEUE_URL: "redis://localhost:6380/15",
  ALLOWED_API_ORIGINS: "http://localhost:3001",
};
const dashboard = {
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-only-key",
  NEXT_PUBLIC_API_URL: "http://localhost:3003",
  NEXT_PUBLIC_URL: "http://localhost:3001",
};

describe("offline runtime doctor", () => {
  test.each([
    "api",
    "worker",
  ] as const)("%s boots with core config only", (service) => {
    expect(inspectEnvironment(service, core).ok).toBe(true);
  });
  test("dashboard does not require optional provider secrets", () => {
    expect(inspectEnvironment("dashboard", dashboard).ok).toBe(true);
  });
  test.each([
    "api",
    "worker",
    "dashboard",
  ] as const)("%s accepts an optional server-only Supabase transport", (service) => {
    for (const value of [
      undefined,
      "",
      "http://api-gw:8000",
      "https://supabase.internal.invalid",
    ]) {
      const result = inspectEnvironment(service, {
        ...(service === "dashboard" ? dashboard : core),
        SUPABASE_INTERNAL_URL: value,
      });
      expect(result.ok).toBe(true);
      expect(
        result.findings.some(
          (item) => item.variable === "SUPABASE_INTERNAL_URL",
        ),
      ).toBe(false);
    }
  });
  test.each([
    "api",
    "worker",
    "dashboard",
  ] as const)("%s rejects invalid internal Supabase URLs without exposing their values", (service) => {
    const marker = "internal-transport-must-not-leak";
    for (const value of [
      `not-a-url-${marker}`,
      `ftp://${marker}.invalid`,
      `http://user:${marker}@api-gw:8000`,
      `http://api-gw:8000?token=${marker}`,
      `http://api-gw:8000#${marker}`,
      ` http://${marker}.invalid`,
    ]) {
      const result = inspectEnvironment(service, {
        ...(service === "dashboard" ? dashboard : core),
        SUPABASE_INTERNAL_URL: value,
      });
      expect(result.ok).toBe(false);
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          variable: "SUPABASE_INTERNAL_URL",
          severity: "error",
        }),
      );
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });
  test.each([
    "DATABASE_PRIMARY_URL",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "REDIS_URL",
    "REDIS_QUEUE_URL",
  ])("API requires %s", (key) => {
    expect(inspectEnvironment("api", { ...core, [key]: "" }).ok).toBe(false);
  });
  test("worker uses its own pool URL and supports Supabase URL fallback", () => {
    expect(
      inspectEnvironment("worker", {
        ...core,
        DATABASE_PRIMARY_URL: undefined,
        SUPABASE_URL: undefined,
        NEXT_PUBLIC_SUPABASE_URL: core.SUPABASE_URL,
      }).ok,
    ).toBe(true);
    expect(
      inspectEnvironment("worker", {
        ...core,
        DATABASE_PRIMARY_POOLER_URL: undefined,
        DATABASE_PRIMARY_URL: undefined,
      }).ok,
    ).toBe(false);
  });
  test("worker requires its service-to-service key", () => {
    expect(
      inspectEnvironment("worker", { ...core, INTERNAL_API_KEY: "" }).ok,
    ).toBe(false);
  });
  test("worker validates the configured internal API URL", () => {
    expect(
      inspectEnvironment("worker", { ...core, API_INTERNAL_URL: "not-a-url" })
        .ok,
    ).toBe(false);
    const fallback = inspectEnvironment("worker", {
      ...core,
      API_INTERNAL_URL: undefined,
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.findings).toContainEqual(
      expect.objectContaining({
        variable: "API_INTERNAL_URL",
        severity: "warning",
      }),
    );
  });
  test("worker supports the existing primary-URL fallback", () => {
    expect(
      inspectEnvironment("worker", {
        ...core,
        DATABASE_PRIMARY_POOLER_URL: undefined,
      }).ok,
    ).toBe(true);
    expect(
      inspectEnvironment("worker", { ...core, DATABASE_PRIMARY_POOLER_URL: "" })
        .ok,
    ).toBe(false);
  });
  test.each([
    "secret",
    "your-api-key",
    "changeme",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is an unresolved env template, deliberately not interpolation.
    "${VARIABLE}",
    "  ",
  ])("rejects template value %s", (value) => {
    expect(
      inspectEnvironment("api", { ...core, SUPABASE_SECRET_KEY: value }).ok,
    ).toBe(false);
  });
  test.each([
    "https://redis.example",
    "redis://localhost/not-a-db",
    "redis://localhost/1?db=2",
    " redis://localhost",
  ])("rejects incompatible Redis URL %s", (value) => {
    expect(
      inspectEnvironment("api", { ...core, REDIS_QUEUE_URL: value }).ok,
    ).toBe(false);
  });
  test.each([
    "0",
    "65536",
    "123oops",
    "-1",
  ])("rejects invalid port %s", (value) => {
    expect(inspectEnvironment("api", { ...core, PORT: value }).ok).toBe(false);
  });
  test.each([
    "http://localhost:3001/",
    "http://localhost:3001/path",
    "http://localhost:3001, https://example.com",
    "*",
  ])("rejects invalid CORS origin %s", (value) => {
    expect(
      inspectEnvironment("api", { ...core, ALLOWED_API_ORIGINS: value }).ok,
    ).toBe(false);
  });
  test("accepts multiple exact CORS origins", () => {
    expect(
      inspectEnvironment("api", {
        ...core,
        ALLOWED_API_ORIGINS: "http://localhost:3001,https://example.com",
      }).ok,
    ).toBe(true);
  });
  test("warns on incomplete worker administration without blocking core", () => {
    const result = inspectEnvironment("worker", {
      ...core,
      BOARD_USERNAME: "admin",
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: "warning" }),
    );
  });
  test("never exposes rejected configuration values in diagnostics", () => {
    const marker = "credential-must-not-leak";
    const result = inspectEnvironment("api", {
      ...core,
      DATABASE_PRIMARY_URL: `invalid://${marker}:password@host`,
      SUPABASE_URL: `https://${marker}:password@host`,
      REDIS_URL: `redis://${marker}:password@host/no-db`,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("password");
  });
  test.each([
    "sb_secret_never-public",
    "same-as-server",
  ])("rejects a server secret in browser config", (key) => {
    expect(
      inspectEnvironment("dashboard", {
        ...dashboard,
        SUPABASE_SECRET_KEY: "same-as-server",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
      }).ok,
    ).toBe(false);
  });
  test("accepts canonical 32-byte Server Actions key", () => {
    expect(
      inspectEnvironment("dashboard", {
        ...dashboard,
        NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString(
          "base64",
        ),
      }).ok,
    ).toBe(true);
  });
  test.each([
    "not-base64",
    Buffer.alloc(16).toString("base64"),
    Buffer.alloc(32).toString("base64").slice(0, -1),
  ])("rejects invalid Server Actions key", (key) => {
    expect(
      inspectEnvironment("dashboard", {
        ...dashboard,
        NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: key,
      }).ok,
    ).toBe(false);
  });
  test("production warns about public HTTP and unstable replica key", () => {
    const result = inspectEnvironment("dashboard", {
      ...dashboard,
      NODE_ENV: "production",
    });
    expect(result.ok).toBe(true);
    expect(
      result.findings.filter((item) => item.severity === "warning"),
    ).toHaveLength(4);
  });
});
