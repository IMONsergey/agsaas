import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import type {
  HostedConsentActor,
  HostedConsentPayload,
} from "@midday/db/bank-consent";
import type { DatabaseOrTransaction } from "@midday/db/client";
import type { HostedBankConsent } from "@midday/db/queries/hosted-bank-consents";

const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error(
    "Real SQL, mail and provider IO are forbidden in consent orchestration units",
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

const actor: HostedConsentActor = {
  teamId: "team-fixture",
  userId: "owner-fixture",
  sessionId: "session-fixture",
  aal: "aal2",
};
const input = { requestId: "request-fixture", country: "US" as const };
const link = {
  linkToken: "link-sandbox-fixture",
  hostedUrl: "https://secure.plaid.com/hl/fixture",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
};
const receipt = {
  accessToken: "access-sandbox-fixture",
  itemId: "item-fixture",
};
let row: HostedBankConsent | null;
let payload: HostedConsentPayload;
let scopeValid: boolean;
let receiptPersistenceFailure: boolean;
const freshRow = (): HostedBankConsent => ({
  ...actor,
  id: "intent-fixture",
  requestId: input.requestId,
  providerEnvironment: "sandbox",
  status: "creating",
  claimToken: "create-fence",
  encryptedPayload: "ciphertext-fixture",
  connectionId: null,
  cleanupId: null,
  reason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  expiresAt: link.expiresAt,
});
const required = () => {
  if (!row) throw new Error("fixture row missing");
  return row;
};
const provider = {
  create: mock(async () => link),
  evidence: mock(
    async (): Promise<{
      publicToken: string;
      linkSessionId: string;
    } | null> => ({
      publicToken: "public-sandbox-fixture",
      linkSessionId: "link-session-fixture",
    }),
  ),
  exchange: mock(async () => receipt),
  accounts: mock(async (_payload: HostedConsentPayload) => ({
    institutionId: "institution-fixture",
    institutionName: "Fixture bank",
    accounts: [
      {
        accountId: "account-fixture",
        name: "Checking",
        currency: "USD",
        type: "depository" as const,
        subtype: "checking",
      },
    ],
  })),
};
const begin = mock(async () => {
  const created = row === null;
  if (!row) row = freshRow();
  return { row, created };
});
const get = mock(async () => {
  if (!scopeValid) throw new Error("fixture scope revoked");
  return required();
});
const retainLink = mock(async () => {
  payload = { ...payload, ...link };
  row = { ...required(), status: "awaiting_consent", claimToken: null };
  return row;
});
const claim = mock(async () => {
  const current = required();
  if (current.status !== "awaiting_consent")
    return { row: current, claimed: false };
  row = { ...current, status: "exchanging", claimToken: "exchange-fence" };
  return { row, claimed: true };
});
const retainAccess = mock(async () => {
  if (receiptPersistenceFailure)
    throw new Error("fixture durable receipt failure");
  payload = { ...payload, ...receipt };
  row = { ...required(), status: "grant_received" };
  return row;
});
const retainGrant = mock(async () => {
  row = { ...required(), status: "verified" };
  return row;
});
const accept = mock(async () => {
  if (!scopeValid) throw new Error("fixture scope revoked");
  row = { ...required(), status: "completed", connectionId: required().id };
  return row;
});
const uncertain = mock(async () => {
  row = {
    ...required(),
    status: "reconciliation",
    reason: "provider_outcome_unknown",
  };
});
mock.module("@midday/db/queries/hosted-bank-consents", () => ({
  beginHostedBankConsent: begin,
  getHostedBankConsent: get,
  retainHostedBankLink: retainLink,
  claimHostedBankExchange: claim,
  retainHostedBankAccess: retainAccess,
  retainHostedBankGrant: retainGrant,
  acceptHostedBankConsent: accept,
  markHostedBankConsentUncertain: uncertain,
  openHostedBankConsent: () => payload,
  hostedBankConsentView: (value: HostedBankConsent, includeUrl: boolean) => ({
    id: value.id,
    status: value.status,
    ...(includeUrl && value.status === "awaiting_consent"
      ? { url: link.hostedUrl }
      : {}),
  }),
}));
mock.module("./plaid-hosted-consent", () => ({
  hostedPlaidConfiguration: () => ({
    environment: "sandbox",
    clientFingerprint: "a".repeat(64),
  }),
  createHostedPlaidTransport: () => provider,
}));
const { startHostedBankConsent, completeHostedBankConsent } = await import(
  "./hosted-bank-consent"
);
// No operation can use this object: every SQL boundary above is explicitly mocked.
const database = {} as DatabaseOrTransaction;

beforeEach(() => {
  row = null;
  scopeValid = true;
  receiptPersistenceFailure = false;
  payload = {
    ...actor,
    id: "intent-fixture",
    version: 1,
    provider: "plaid",
    environment: "sandbox",
    clientFingerprint: "a".repeat(64),
    country: "US",
  };
  for (const fn of [
    begin,
    get,
    retainLink,
    claim,
    retainAccess,
    retainGrant,
    accept,
    uncertain,
  ])
    fn.mockClear();
  provider.create.mockReset();
  provider.create.mockImplementation(async () => link);
  provider.evidence.mockReset();
  provider.evidence.mockImplementation(async () => ({
    publicToken: "public-sandbox-fixture",
    linkSessionId: "link-session-fixture",
  }));
  provider.exchange.mockReset();
  provider.exchange.mockImplementation(async () => receipt);
  provider.accounts.mockClear();
});

describe("durable bank consent orchestration", () => {
  test("an idempotent start publishes the provider URL only after link retention and owner recheck", async () => {
    const first = await startHostedBankConsent(database, actor, input);
    const second = await startHostedBankConsent(database, actor, input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "awaiting_consent",
      url: link.hostedUrl,
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(retainLink).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(database, actor, "intent-fixture");
    expect(JSON.stringify(first)).not.toContain(link.linkToken);
  });
  test("lost create response retains an uncertain fence and a repeated command does not create again", async () => {
    provider.create.mockImplementation(async () => {
      throw new Error("fixture timeout after provider request");
    });
    await expect(
      startHostedBankConsent(database, actor, input),
    ).rejects.toThrow("fixture timeout");
    expect(uncertain).toHaveBeenCalledWith(
      database,
      "intent-fixture",
      "create-fence",
    );
    expect(await startHostedBankConsent(database, actor, input)).toMatchObject({
      status: "reconciliation",
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(retainLink).not.toHaveBeenCalled();
  });
  test("owner revocation during provider IO prevents capability URL disclosure", async () => {
    provider.create.mockImplementation(async () => {
      scopeValid = false;
      return link;
    });
    await expect(
      startHostedBankConsent(database, actor, input),
    ).rejects.toThrow("scope revoked");
    expect(retainLink).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });
  test("no verified server evidence means no exchange, account fetch or acceptance", async () => {
    await startHostedBankConsent(database, actor, input);
    provider.evidence.mockImplementation(async () => null);
    expect(
      await completeHostedBankConsent(database, actor, "intent-fixture"),
    ).toMatchObject({ status: "awaiting_consent" });
    expect(claim).not.toHaveBeenCalled();
    expect(provider.exchange).not.toHaveBeenCalled();
    expect(provider.accounts).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
  test("successful proof retains access before metadata and accepts exactly once", async () => {
    await startHostedBankConsent(database, actor, input);
    expect(
      await completeHostedBankConsent(database, actor, "intent-fixture"),
    ).toMatchObject({ status: "completed" });
    expect(retainAccess).toHaveBeenCalledWith(database, {
      id: "intent-fixture",
      claimToken: "exchange-fence",
      ...receipt,
    });
    expect(provider.accounts.mock.calls[0]?.[0]).toMatchObject(receipt);
    expect(retainGrant).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(database, actor, "intent-fixture");
    await completeHostedBankConsent(database, actor, "intent-fixture");
    expect(provider.exchange).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });
  test("uncertain exchange or receipt persistence never causes a second exchange", async () => {
    await startHostedBankConsent(database, actor, input);
    receiptPersistenceFailure = true;
    await expect(
      completeHostedBankConsent(database, actor, "intent-fixture"),
    ).rejects.toThrow("durable receipt failure");
    expect(uncertain).toHaveBeenCalledWith(
      database,
      "intent-fixture",
      "exchange-fence",
    );
    expect(
      await completeHostedBankConsent(database, actor, "intent-fixture"),
    ).toMatchObject({ status: "reconciliation" });
    expect(provider.exchange).toHaveBeenCalledTimes(1);
    expect(provider.accounts).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
  test("metadata outage keeps the durable grant and retries only idempotent reads", async () => {
    await startHostedBankConsent(database, actor, input);
    provider.accounts.mockImplementationOnce(async () => {
      throw new Error("fixture metadata outage");
    });
    await expect(
      completeHostedBankConsent(database, actor, "intent-fixture"),
    ).rejects.toThrow("metadata outage");
    expect(required().status).toBe("grant_received");
    expect(uncertain).not.toHaveBeenCalled();
    expect(
      await completeHostedBankConsent(database, actor, "intent-fixture"),
    ).toMatchObject({ status: "completed" });
    expect(provider.exchange).toHaveBeenCalledTimes(1);
    expect(provider.accounts).toHaveBeenCalledTimes(2);
  });
});
