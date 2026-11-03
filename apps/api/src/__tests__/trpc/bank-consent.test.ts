import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mocks } from "../setup";
import { createTestContext } from "../helpers/test-context";
let providerConstructions = 0;
const providerCalls: unknown[] = [];
class DeniedProvider { constructor() { providerConstructions++; } }
mock.module("@midday/banking", () => ({
  Provider: class { constructor() { providerConstructions++; } async getAccounts(input: unknown) { providerCalls.push(input); return []; } },
  PlaidApi: DeniedProvider, GoCardLessApi: DeniedProvider, EnableBankingApi: DeniedProvider,
  ProviderError: class extends Error {}, getProviderErrorDetails: () => ({}), getRates: async () => [],
}));
const { createCallerFactory } = await import("../../trpc/init");
const { bankingRouter } = await import("../../trpc/routers/banking");
const { bankConnectionsRouter } = await import("../../trpc/routers/bank-connections");
const connectionId = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  providerConstructions = 0; providerCalls.length = 0;
  mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("owner"));
  mocks.getBankConnections.mockImplementation(() => Promise.resolve([{ id: connectionId, provider: "gocardless", status: "connected", referenceId: "owned-provider-reference", accessToken: "server-only-credential", institutionId: "owned-institution" }]));
  mocks.createBankConnection.mockClear(); mocks.reconnectBankConnection.mockClear();
});
describe("bank provider targets require trusted ownership", () => {
  test("raw browser provider identifiers cannot start provider IO", async () => {
    const caller = createCallerFactory(bankingRouter)(createTestContext());
    await expect(caller.getProviderAccounts({ provider: "gocardless", id: "foreign-reference", accessToken: "supplied-token" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(providerConstructions).toBe(0);
  });
  test("a foreign connection and provider mismatch are indistinguishable from missing", async () => {
    const caller = createCallerFactory(bankingRouter)(createTestContext());
    await expect(caller.getProviderAccounts({ provider: "gocardless", connectionId: "00000000-0000-4000-8000-000000000002" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.getProviderAccounts({ provider: "plaid", connectionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(providerConstructions).toBe(0);
  });
  test("an owner listing an existing connection uses only primary DB credentials", async () => {
    const caller = createCallerFactory(bankingRouter)(createTestContext());
    expect(await caller.getProviderAccounts({ provider: "gocardless", connectionId, id: "forged-reference", accessToken: "forged-token", institutionId: "forged-institution" })).toEqual({ data: [] });
    expect(providerCalls).toEqual([{ id: "owned-provider-reference", accessToken: "server-only-credential", institutionId: "owned-institution" }]);
  });
  test("unverified link/exchange/reconnect operations fail before provider or persistence", async () => {
    const caller = createCallerFactory(bankingRouter)(createTestContext());
    const connections = createCallerFactory(bankConnectionsRouter)(createTestContext());
    for (const operation of [
      () => caller.plaidLink({}), () => caller.plaidExchange({ token: "unverified" }),
      () => caller.gocardlessLink({ institutionId: "institution", agreement: "agreement", redirect: "https://app.example.test/" }),
      () => caller.enablebankingLink({ institutionId: "institution", state: "web:connect" }),
      () => caller.enablebankingExchange({ code: "unverified" }),
      () => connections.reconnect({ referenceId: "old", newReferenceId: "foreign", expiresAt: "2026-12-01T00:00:00Z" }),
      () => connections.create({ provider: "gocardless", referenceId: "foreign", accounts: [] }),
      () => connections.addAccounts({ connectionId, accounts: [] }),
    ]) await expect(operation()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(providerConstructions).toBe(0);
    expect(mocks.createBankConnection).not.toHaveBeenCalled(); expect(mocks.reconnectBankConnection).not.toHaveBeenCalled();
  });
  test("the bank connections public response never contains its stored credential", async () => {
    const result = await createCallerFactory(bankConnectionsRouter)(createTestContext()).get();
    expect(result[0]?.accessToken).toBeNull();
    expect(JSON.stringify(result)).not.toContain("server-only-credential");
  });
});
