import { describe, expect, test } from "bun:test";
import { getInstanceCapabilities } from "../../utils/instance-capabilities";

describe("instance capabilities", () => {
  test("a self-hosted installation without optional providers advertises none as ready", () => {
    const value = getInstanceCapabilities({});
    expect(
      Object.values(value.integrations).every((item) => !item.enabled),
    ).toBe(true);
    for (const key of [
      "enrichment",
      "ai",
      "banking",
      "hostedBanking",
      "connectors",
      "email",
      "billing",
    ] as const)
      expect(value[key].enabled).toBe(false);
  });
  test("partial and whitespace configuration does not enable an integration", () => {
    expect(
      getInstanceCapabilities({
        GMAIL_CLIENT_ID: "fixture",
        GMAIL_CLIENT_SECRET: " ",
      }).integrations.gmail?.enabled,
    ).toBe(false);
    expect(
      getInstanceCapabilities({
        PLAID_CLIENT_ID: "fixture",
        PLAID_SECRET: "fixture",
      }).banking.enabled,
    ).toBe(false);
  });
  test("native Hosted Link capability never opens unverified legacy banking", () => {
    const value = getInstanceCapabilities({
      NODE_ENV: "production",
      AGSAAS_PLAID_HOSTED_LINK_ENABLED: "true",
      PLAID_ENVIRONMENT: "sandbox",
      PLAID_CLIENT_ID: "private-client",
      PLAID_SECRET: "private-secret",
      MIDDAY_ENCRYPTION_KEY: "37".repeat(32),
      DASHBOARD_URL: "https://dashboard.example.test",
      API_URL: "https://api.example.test",
    });
    expect(value.hostedBanking.enabled).toBe(true);
    expect(value.banking.enabled).toBe(false);
    expect(JSON.stringify(value)).not.toContain("private-client");
    expect(JSON.stringify(value)).not.toContain("private-secret");
  });
  test("returns configuration booleans without exposing credentials", () => {
    const value = getInstanceCapabilities({
      GMAIL_CLIENT_ID: "private-fixture-id",
      GMAIL_CLIENT_SECRET: "private-fixture-secret",
      GMAIL_REDIRECT_URI: "https://private-fixture/callback",
      RESEND_API_KEY: "private-fixture-email",
      EMAIL_FROM: "Company <mail@example.test>",
      DASHBOARD_URL: "https://dashboard.example.test",
    });
    expect(value.integrations.gmail?.enabled).toBe(true);
    expect(value.email.enabled).toBe(true);
    expect(JSON.stringify(value)).not.toContain("private-fixture");
  });
});
