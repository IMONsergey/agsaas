import { afterAll, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import type { HostedConsentPayload } from "@midday/db/bank-consent";
import {
  createHostedPlaidTransport,
  hostedLinkEvidence,
  hostedPlaidCapability,
  hostedPlaidConfiguration,
  HostedPlaidUnavailableError,
  validateHostedPlaidUrl,
  verifiedHostedPlaidAccounts,
  type HostedPlaidFetch,
} from "./plaid-hosted-consent";

const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error(
    "Live provider/network calls are forbidden in consent unit tests",
  );
};
globalThis.fetch = Object.assign(async () => forbidden(), {
  preconnect: forbidden,
});
Socket.prototype.connect = forbidden;
afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
});

const env = {
  NODE_ENV: "production",
  AGSAAS_PLAID_HOSTED_LINK_ENABLED: "true",
  PLAID_ENVIRONMENT: "sandbox",
  PLAID_CLIENT_ID: "client-fixture",
  PLAID_SECRET: "secret-fixture",
  MIDDAY_ENCRYPTION_KEY: "37".repeat(32),
  DASHBOARD_URL: "https://dashboard.example.test",
  API_URL: "https://api.example.test",
};
const config = hostedPlaidConfiguration(env);
const now = Date.now();
const times = {
  createdAt: new Date(now - 60000).toISOString(),
  expiresAt: new Date(now + 60000).toISOString(),
};
const linkToken = "link-sandbox-fixture";
const evidence = {
  link_token: linkToken,
  link_sessions: [
    {
      link_session_id: "session-fixture",
      finished_at: new Date(now).toISOString(),
      results: {
        item_add_results: [{ public_token: "public-sandbox-fixture" }],
      },
    },
  ],
};
const envelope: HostedConsentPayload = {
  id: "intent-fixture",
  teamId: "team-fixture",
  userId: "owner-fixture",
  sessionId: "session-fixture",
  version: 1,
  provider: "plaid",
  environment: "sandbox",
  clientFingerprint: config.clientFingerprint,
  country: "US",
  linkToken,
};
const accountResult = {
  item: { item_id: "item-fixture", institution_id: "institution-fixture" },
  accounts: [
    {
      account_id: "account-fixture",
      name: "Checking",
      type: "depository",
      subtype: "checking",
      balances: { iso_currency_code: "USD", current: 999999 },
    },
  ],
};

describe("native Plaid Hosted Link proof", () => {
  test("optional configuration requires an explicit feature, environment, encryption and own origins", () => {
    expect(hostedPlaidCapability({}).enabled).toBe(false);
    for (const changed of [
      { AGSAAS_PLAID_HOSTED_LINK_ENABLED: "false" },
      { PLAID_ENVIRONMENT: undefined },
      { PLAID_ENVIRONMENT: "development" },
      { MIDDAY_ENCRYPTION_KEY: "short" },
      { PLAID_SECRET: " " },
      { DASHBOARD_URL: "https://app.midday.ai" },
      { API_URL: "https://api.example.test/path" },
    ]) {
      expect(hostedPlaidCapability({ ...env, ...changed }).enabled).toBe(false);
    }
    const capability = hostedPlaidCapability(env);
    expect(capability).toEqual({
      enabled: true,
      environment: "sandbox",
      countries: ["US", "CA"],
      reason: null,
    });
    expect(JSON.stringify(capability)).not.toContain("fixture");
    expect(JSON.stringify(capability)).not.toContain(config.clientFingerprint);
  });
  test("completion redirects, browser public tokens and unfinished sessions are not consent evidence", () => {
    expect(() =>
      hostedLinkEvidence(
        { public_token: "public-sandbox-fixture", success: true },
        { linkToken, environment: "sandbox", ...times },
      ),
    ).toThrow();
    expect(
      hostedLinkEvidence(
        { ...evidence, link_sessions: [] },
        { linkToken, environment: "sandbox", ...times },
      ),
    ).toBeNull();
    expect(
      hostedLinkEvidence(
        {
          ...evidence,
          link_sessions: [{ ...evidence.link_sessions[0], finished_at: null }],
        },
        { linkToken, environment: "sandbox", ...times },
      ),
    ).toBeNull();
    expect(
      hostedLinkEvidence(evidence, {
        linkToken,
        environment: "sandbox",
        ...times,
      }),
    ).toEqual({
      publicToken: "public-sandbox-fixture",
      linkSessionId: "session-fixture",
    });
  });
  test("exact link, timestamp, environment and one successful Item are mandatory", () => {
    for (const input of [
      { linkToken: "foreign" },
      { environment: "production" },
      { createdAt: "not-a-date" },
      { expiresAt: new Date(now - 1000).toISOString() },
    ]) {
      expect(() =>
        hostedLinkEvidence(evidence, {
          linkToken,
          environment: "sandbox",
          ...times,
          ...input,
        }),
      ).toThrow(HostedPlaidUnavailableError);
    }
    const second = {
      ...evidence.link_sessions[0],
      link_session_id: "other-session",
      results: {
        item_add_results: [{ public_token: "public-sandbox-second" }],
      },
    };
    expect(() =>
      hostedLinkEvidence(
        { ...evidence, link_sessions: [...evidence.link_sessions, second] },
        { linkToken, environment: "sandbox", ...times },
      ),
    ).toThrow(HostedPlaidUnavailableError);
    expect(() =>
      hostedLinkEvidence(
        {
          ...evidence,
          link_sessions: [
            ...evidence.link_sessions,
            { ...evidence.link_sessions[0], link_session_id: "other-session" },
          ],
        },
        { linkToken, environment: "sandbox", ...times },
      ),
    ).toThrow(HostedPlaidUnavailableError);
  });
  test("hosted URLs cannot redirect to a foreign origin or contain credentials", () => {
    expect(validateHostedPlaidUrl("https://secure.plaid.com/hl/fixture")).toBe(
      "https://secure.plaid.com/hl/fixture",
    );
    for (const url of [
      "https://secure.plaid.com.attacker.test/hl/a",
      "http://secure.plaid.com/hl/a",
      "https://user@secure.plaid.com/hl/a",
      "https://secure.plaid.com:444/hl/a",
      "https://secure.plaid.com/hl/a#fragment",
    ]) {
      expect(() => validateHostedPlaidUrl(url)).toThrow();
    }
  });
  test("provider accounts are tied to the exact exchanged item and never import a balance", () => {
    expect(verifiedHostedPlaidAccounts(accountResult, "item-fixture")).toEqual({
      institutionId: "institution-fixture",
      accounts: [
        {
          accountId: "account-fixture",
          name: "Checking",
          currency: "USD",
          type: "depository",
          subtype: "checking",
        },
      ],
    });
    expect(() =>
      verifiedHostedPlaidAccounts(accountResult, "foreign-item"),
    ).toThrow(HostedPlaidUnavailableError);
    expect(() =>
      verifiedHostedPlaidAccounts(
        {
          ...accountResult,
          item: { ...accountResult.item, institution_id: null },
        },
        "item-fixture",
      ),
    ).toThrow(HostedPlaidUnavailableError);
  });
  test("transport uses a fixed provider origin and own callback, without link delivery or browser credentials", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport: HostedPlaidFetch = async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        link_token: linkToken,
        expiration: times.expiresAt,
        hosted_link_url: "https://secure.plaid.com/hl/fixture",
      });
    };
    await createHostedPlaidTransport(config, transport).create({
      id: "intent-fixture",
      country: "US",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(calls[0]?.init.redirect).toBe("error");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.hosted_link).toEqual({
      url_lifetime_seconds: 1800,
      completion_redirect_uri:
        "https://dashboard.example.test/settings/accounts?bankConsent=intent-fixture",
    });
    expect(body.webhook).toBe("https://api.example.test/webhook/plaid");
    expect(body.user).toEqual({
      client_user_id: "agsaas-consent-intent-fixture",
    });
    expect(body).not.toHaveProperty("public_token");
    expect(body.hosted_link).not.toHaveProperty("delivery_method");
  });
  test("configuration drift is rejected before evidence or account HTTP", async () => {
    let calls = 0;
    const transport: HostedPlaidFetch = async () => {
      calls++;
      return Response.json(evidence);
    };
    const provider = createHostedPlaidTransport(config, transport);
    await expect(
      provider.evidence(
        { ...envelope, clientFingerprint: "b".repeat(64) },
        times,
      ),
    ).rejects.toThrow(HostedPlaidUnavailableError);
    await expect(
      provider.accounts({
        ...envelope,
        environment: "production",
        itemId: "item-fixture",
        accessToken: "access-production-fixture",
      }),
    ).rejects.toThrow(HostedPlaidUnavailableError);
    await expect(
      provider.exchange("public-production-fixture"),
    ).rejects.toThrow(HostedPlaidUnavailableError);
    expect(calls).toBe(0);
  });
  test("transport errors and oversized bodies are bounded, redacted and never retried", async () => {
    for (const response of [
      new Response("secret-provider-body", { status: 500 }),
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
      new Response("invalid-json-secret"),
    ]) {
      let calls = 0;
      const transport: HostedPlaidFetch = async () => {
        calls++;
        return response;
      };
      let failure: unknown;
      try {
        await createHostedPlaidTransport(config, transport).evidence(
          envelope,
          times,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HostedPlaidUnavailableError);
      expect(String(failure)).not.toContain("secret-provider-body");
      expect(String(failure)).not.toContain("invalid-json-secret");
      expect(calls).toBe(1);
    }
  });
  test("exchange response from another environment is never retained as an authorized grant", async () => {
    const transport: HostedPlaidFetch = async () =>
      Response.json({
        access_token: "access-production-foreign",
        item_id: "item-fixture",
      });
    await expect(
      createHostedPlaidTransport(config, transport).exchange(
        "public-sandbox-fixture",
      ),
    ).rejects.toThrow(HostedPlaidUnavailableError);
  });
});
