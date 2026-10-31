import { describe, expect, test } from "bun:test";
import {
  assertBuildInputChangesHash,
  buildContractEnvironment,
  hashedBuildInputs,
  inspectDashboardBuildReport,
} from "./test-dashboard-build-contract";

function fixture() {
  return {
    envMode: "strict",
    tasks: [
      {
        taskId: "@midday/dashboard#build",
        envMode: "strict",
        framework: "nextjs",
        hash: "0123456789abcdef",
        inputs: {
          "package.json": "hash",
          "next.config.ts": "hash",
          "src/app/[locale]/layout.tsx": "hash",
        },
        resolvedTaskDefinition: {
          outputs: [".next/**", "!.next/cache/**"],
          inputs: [".env"],
          dependsOn: ["^build"],
        },
        environmentVariables: {
          configured: hashedBuildInputs.map((name) => `${name}=hash`),
          inferred: ["NEXT_PUBLIC_API_URL=hash"],
          passthrough: [] as string[],
        },
      },
    ],
  };
}

describe("dashboard build contract report", () => {
  test("accepts strict Next.js build with hashed inputs and intact cache outputs", () => {
    expect(inspectDashboardBuildReport(JSON.stringify(fixture()))).toEqual({
      hash: "0123456789abcdef",
    });
  });
  test.each(hashedBuildInputs)("rejects passthrough-only %s", (name) => {
    const report = fixture();
    const variables = report.tasks[0]!.environmentVariables;
    variables.configured = variables.configured.filter(
      (entry) => !entry.startsWith(`${name}=`),
    );
    variables.passthrough.push(`${name}=do-not-print`);
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      `${name} must be a hashed build input`,
    );
  });
  test.each([
    "outputs",
    "inputs",
    "dependsOn",
  ] as const)("rejects lost %s from a non-inheriting task override", (field) => {
    const report = fixture();
    report.tasks[0]!.resolvedTaskDefinition[field] = [];
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow();
  });
  test.each([
    "loose",
    "",
    "unexpected",
  ])("rejects environment mode %s", (mode) => {
    const report = fixture();
    report.tasks[0]!.envMode = mode;
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "strict environment mode",
    );
  });
  test("rejects missing public build input", () => {
    const report = fixture();
    report.tasks[0]!.environmentVariables.inferred = [];
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "NEXT_PUBLIC_API_URL",
    );
  });
  test.each([
    "configured",
    "inferred",
    "passthrough",
  ] as const)("rejects undeclared input in %s", (group) => {
    const report = fixture();
    report.tasks[0]!.environmentVariables[group].push(
      "DASHBOARD_BUILD_CONTRACT_UNDECLARED=do-not-print",
    );
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "undeclared environment variable",
    );
  });
  test("global passthrough cannot leak an undeclared input into a strict task", () => {
    const report = {
      ...fixture(),
      globalCacheInputs: {
        environmentVariables: {
          passthrough: ["DASHBOARD_BUILD_CONTRACT_UNDECLARED=do-not-print"],
        },
      },
    };
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "undeclared environment variable",
    );
  });
  test.each([
    "secret-must-not-appear",
    JSON.stringify({ tasks: [{ secret: "secret-must-not-appear" }] }),
    "null",
  ])("malformed reports do not leak payloads", (raw) => {
    try {
      inspectDashboardBuildReport(raw);
      throw new Error("Unexpected successful inspection");
    } catch (error) {
      expect(String(error)).not.toContain("secret-must-not-appear");
      expect(String(error)).not.toContain("Unexpected successful inspection");
    }
  });
  test("a build input must invalidate the task hash", () => {
    expect(() =>
      assertBuildInputChangesHash("SENTRY_RELEASE", "a", "a"),
    ).toThrow("invalidating");
    expect(() =>
      assertBuildInputChangesHash("SENTRY_RELEASE", "a", "b"),
    ).not.toThrow();
  });
  test("sterile subprocess environment does not forward credentials or execution overrides", () => {
    const env = buildContractEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp",
      SUPABASE_SECRET_KEY: "secret-must-not-appear",
      SENTRY_AUTH_TOKEN: "secret-must-not-appear",
      NODE_OPTIONS: "--require=untrusted",
      BUN_OPTIONS: "untrusted",
      TURBO_BINARY_PATH: "/untrusted",
      HTTPS_PROXY: "secret-must-not-appear",
      GIT_COMMIT_SHA: "secret-must-not-appear",
      NEXT_PUBLIC_API_URL: "secret-must-not-appear",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp");
    expect(JSON.stringify(env)).not.toContain("secret-must-not-appear");
    for (const name of [
      "SUPABASE_SECRET_KEY",
      "SENTRY_AUTH_TOKEN",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "TURBO_BINARY_PATH",
      "HTTPS_PROXY",
    ]) {
      expect(env[name]).toBeUndefined();
    }
  });
});
