import { describe, expect, test } from "bun:test";
import {
  BankConsentError,
  type HostedConsentPayload,
  hostedPlaidClientBinding,
  matchesHostedPlaidClient,
  type VerifiedConsentAccount,
  validateConsentAccounts,
  verifyConsentEnvelope,
} from "./bank-consent";

const scope = {
  id: "intent-fixture",
  teamId: "team-fixture",
  userId: "owner-fixture",
  sessionId: "session-fixture",
};
const payload: HostedConsentPayload = {
  ...scope,
  version: 1,
  provider: "plaid",
  environment: "sandbox",
  clientFingerprint: "a".repeat(64),
  country: "US",
};
const account: VerifiedConsentAccount = {
  accountId: "account-fixture",
  name: "Checking",
  currency: "USD",
  type: "depository",
  subtype: "checking",
};

describe("retained bank consent boundaries", () => {
  test("the envelope is bound to exact intent, tenant, owner, session and provider", () => {
    expect(verifyConsentEnvelope(payload, scope)).toEqual(payload);
    for (const key of ["id", "teamId", "userId", "sessionId"] as const) {
      expect(() =>
        verifyConsentEnvelope({ ...payload, [key]: "foreign" }, scope),
      ).toThrow(BankConsentError);
    }
    for (const changed of [
      { provider: "teller" },
      { environment: "development" },
      { country: "GB" },
      { clientFingerprint: "raw-client-id" },
      { accessToken: "bad\ntoken" },
    ]) {
      expect(() =>
        verifyConsentEnvelope({ ...payload, ...changed }, scope),
      ).toThrow(BankConsentError);
    }
  });
  test("accounts have unique identities, real currency and explicit classification", () => {
    expect(validateConsentAccounts([account])).toEqual([account]);
    for (const accounts of [
      [],
      [account, account],
      [{ ...account, currency: null }],
      [{ ...account, currency: "XXY" }],
      [{ ...account, type: "unknown" }],
      [{ ...account, name: "bad\rname" }],
    ]) {
      expect(() => validateConsentAccounts(accounts)).toThrow(BankConsentError);
    }
    expect(() =>
      validateConsentAccounts(
        Array.from({ length: 101 }, (_, index) => ({
          ...account,
          accountId: `${index}`,
        })),
      ),
    ).toThrow(BankConsentError);
  });
  test("balances, selected flags and provider tokens cannot become accepted account metadata", () => {
    expect(
      validateConsentAccounts([
        {
          ...account,
          balance: 999999,
          enabled: true,
          accessToken: "untrusted",
        },
      ]),
    ).toEqual([account]);
  });
  test("cleanup requires the originating explicit environment and client, independently of UI enablement", () => {
    const env = {
      PLAID_ENVIRONMENT: "sandbox",
      PLAID_CLIENT_ID: "client-fixture",
    };
    const binding = hostedPlaidClientBinding(env)!;
    expect(matchesHostedPlaidClient(binding, env)).toBe(true);
    expect(
      matchesHostedPlaidClient(binding, {
        ...env,
        AGSAAS_PLAID_HOSTED_LINK_ENABLED: "false",
        PLAID_SECRET: "rotated-secret",
      }),
    ).toBe(true);
    expect(
      matchesHostedPlaidClient(binding, {
        ...env,
        PLAID_ENVIRONMENT: "production",
      }),
    ).toBe(false);
    expect(
      matchesHostedPlaidClient(binding, {
        ...env,
        PLAID_CLIENT_ID: "other-client",
      }),
    ).toBe(false);
    expect(matchesHostedPlaidClient(binding, {})).toBe(false);
    expect(
      hostedPlaidClientBinding({ PLAID_CLIENT_ID: "client-fixture" }),
    ).toBeNull();
    expect(JSON.stringify(binding)).not.toContain("client-fixture");
  });
});
