import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt } from "@midday/encryption";
import type { HostedConsentPayload } from "../bank-consent";
import {
  hostedBankConsentView,
  openHostedBankConsent,
  type HostedBankConsent,
} from "../queries/hosted-bank-consents";

const previousKey = process.env.MIDDAY_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.MIDDAY_ENCRYPTION_KEY = "37".repeat(32);
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.MIDDAY_ENCRYPTION_KEY;
  else process.env.MIDDAY_ENCRYPTION_KEY = previousKey;
});
const scope = {
  teamId: "tenant-fixture",
  userId: "owner-fixture",
  sessionId: "session-fixture",
};
const payload: HostedConsentPayload = {
  ...scope,
  id: "intent-fixture",
  version: 1,
  provider: "plaid",
  environment: "sandbox",
  clientFingerprint: "a".repeat(64),
  country: "US",
  linkToken: "link-sandbox-secret",
  publicToken: "public-sandbox-secret",
  accessToken: "access-sandbox-secret",
  itemId: "private-item",
  hostedUrl: "https://secure.plaid.com/hl/private-fixture",
};
const fixture = (): HostedBankConsent => ({
  ...scope,
  id: payload.id,
  requestId: "request-fixture",
  providerEnvironment: "sandbox",
  status: "awaiting_consent",
  claimToken: "private-claim",
  encryptedPayload: encrypt(JSON.stringify(payload)),
  connectionId: null,
  cleanupId: null,
  reason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});

describe("bank consent public projection", () => {
  test("ordinary status contains no credential, claim, ciphertext or actor identity", () => {
    const row = fixture();
    const view = hostedBankConsentView(row);
    expect(Object.keys(view).sort()).toEqual([
      "cleanupId",
      "connectionId",
      "expiresAt",
      "id",
      "reason",
      "status",
    ]);
    const serialized = JSON.stringify(view);
    for (const privateValue of [
      payload.linkToken!,
      payload.publicToken!,
      payload.accessToken!,
      payload.itemId!,
      payload.hostedUrl!,
      row.claimToken!,
      row.encryptedPayload,
      scope.userId,
      scope.sessionId,
    ])
      expect(serialized).not.toContain(privateValue);
  });
  test("only explicit current pending-link reads expose the bounded provider URL", () => {
    const row = fixture();
    expect(hostedBankConsentView(row, true)).toMatchObject({
      url: payload.hostedUrl,
    });
    expect(
      hostedBankConsentView(
        { ...row, expiresAt: new Date(Date.now() - 1).toISOString() },
        true,
      ),
    ).not.toHaveProperty("url");
    for (const status of [
      "creating",
      "exchanging",
      "grant_received",
      "verified",
      "completed",
      "cleanup_requested",
      "cleanup_pending",
      "canceled",
      "reconciliation",
    ] as const) {
      expect(
        hostedBankConsentView({ ...row, status }, true),
      ).not.toHaveProperty("url");
    }
  });
  test("moving valid ciphertext to another row, user, tenant, session or environment is rejected", () => {
    const row = fixture();
    expect(openHostedBankConsent(row)).toEqual(payload);
    for (const key of ["id", "teamId", "userId", "sessionId"] as const)
      expect(() =>
        openHostedBankConsent({ ...row, [key]: "foreign" }),
      ).toThrow();
    expect(() =>
      openHostedBankConsent({ ...row, providerEnvironment: "production" }),
    ).toThrow();
    expect(() =>
      openHostedBankConsent({ ...row, encryptedPayload: "unreadable" }),
    ).toThrow();
  });
});
