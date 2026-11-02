import { describe, expect, test } from "bun:test";
import { createBankingEnvironment } from "./env";

function runWithoutEnvironment(source: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "--eval", source],
    cwd: __dirname,
    env: {},
    timeout: 5_000,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("banking environment", () => {
  test("imports banking, institutions and storage without optional credentials", () => {
    const result = runWithoutEnvironment(`
      import { Provider } from "./index.ts";
      import { fetchAllInstitutions } from "./institutions.ts";
      import { logoExists } from "./utils/storage.ts";
      if ([Provider, fetchAllInstitutions, logoExists].every(value => typeof value === "function")) {
        console.log("banking-import-ok");
      }
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("banking-import-ok");
    expect(result.stderr.toString()).not.toContain("environment variables");
  });

  test.each([
    ["plaid", "Plaid", "PLAID_CLIENT_ID", "PLAID_SECRET"],
    [
      "gocardless",
      "GoCardless",
      "GOCARDLESS_SECRET_ID",
      "GOCARDLESS_SECRET_KEY",
    ],
    [
      "enablebanking",
      "EnableBanking",
      "ENABLEBANKING_APPLICATION_ID",
      "ENABLE_BANKING_KEY_CONTENT",
    ],
  ])("rejects unconfigured %s before making requests", (provider, label, id, secret) => {
    const result = runWithoutEnvironment(`
      import { Provider } from "./index.ts";
      new Provider({ provider: ${JSON.stringify(provider)} });
    `);
    const error = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(error).toContain(
      `Missing or invalid ${label} environment variables`,
    );
    expect(error).toContain(id);
    expect(error).toContain(secret);
    expect(error).not.toContain("R2_SECRET_ACCESS_KEY");
  });

  test("validates only the selected group and keeps Plaid's default environment", () => {
    const env = createBankingEnvironment({
      PLAID_CLIENT_ID: "unit-test-client-id",
      PLAID_SECRET: "unit-test-secret",
    });

    expect(env.PLAID_CLIENT_ID).toBe("unit-test-client-id");
    expect(env.PLAID_ENVIRONMENT).toBe("production");
    expect(() => env.GOCARDLESS_SECRET_ID).toThrow("GOCARDLESS_SECRET_KEY");
  });

  test("selected-provider health does not construct other bank integrations", () => {
    const result = runWithoutEnvironment(`
      import { Provider } from "./index.ts";
      import { TellerProvider } from "./providers/teller/teller-provider.ts";
      let calls = 0;
      TellerProvider.prototype.getHealthCheck = async () => {
        calls++;
        return true;
      };
      const healthy = await new Provider({ provider: "teller" }).getProviderHealthCheck();
      if (healthy && calls === 1) console.log("single-provider-ok");
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("single-provider-ok");
  });

  test("requires all Teller credentials when an authenticated operation reads them", () => {
    const env = createBankingEnvironment({});

    expect(() => env.TELLER_CERT_BASE64).toThrow("TELLER_CERT_BASE64");
    expect(() => env.TELLER_CERT_BASE64).toThrow("TELLER_KEY_BASE64");
  });

  test("does not expose invalid values in configuration errors", () => {
    const invalidEndpoint = "private-value-not-a-url";
    const env = createBankingEnvironment({ R2_ENDPOINT: invalidEndpoint });
    let message = "";
    try {
      void env.R2_ENDPOINT;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("R2_ENDPOINT");
    expect(message).toContain("R2_ACCESS_KEY_ID");
    expect(message).not.toContain(invalidEndpoint);
  });

  test("retains server-only access protection", () => {
    const env = createBankingEnvironment({}, { isServer: false });

    expect(() => env.PLAID_SECRET).toThrow("server-side environment variable");
  });

  test("caches a validated group, not an earlier validation failure", () => {
    const source: Record<string, string | undefined> = {};
    const env = createBankingEnvironment(source);

    expect(() => env.LOGO_DEV_TOKEN).toThrow("LOGO_DEV_TOKEN");
    source.LOGO_DEV_TOKEN = "unit-test-token";
    expect(env.LOGO_DEV_TOKEN).toBe("unit-test-token");
    source.LOGO_DEV_TOKEN = "changed-after-validation";
    expect(env.LOGO_DEV_TOKEN).toBe("unit-test-token");
  });
});
