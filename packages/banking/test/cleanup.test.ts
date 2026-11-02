import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import {
  type BankCleanupTarget,
  isBankCleanupConfigured,
  revokeBankConnection,
} from "../src/cleanup";
import { TellerApi } from "../src/providers/teller/teller-api";

const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const previousCert = process.env.TELLER_CERT_BASE64;
const previousKey = process.env.TELLER_KEY_BASE64;
process.env.TELLER_CERT_BASE64 = Buffer.from(
  "fixture-not-a-certificate",
).toString("base64");
process.env.TELLER_KEY_BASE64 = Buffer.from(
  "fixture-not-a-private-key",
).toString("base64");
const forbidden = (): never => {
  throw new Error("Real provider/network access is forbidden in cleanup tests");
};
Socket.prototype.connect = forbidden;
beforeEach(() => {
  globalThis.fetch = Object.assign(async () => forbidden(), {
    preconnect: forbidden,
  });
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
  if (previousCert === undefined) delete process.env.TELLER_CERT_BASE64;
  else process.env.TELLER_CERT_BASE64 = previousCert;
  if (previousKey === undefined) delete process.env.TELLER_KEY_BASE64;
  else process.env.TELLER_KEY_BASE64 = previousKey;
});
const target: BankCleanupTarget = {
  provider: "plaid",
  referenceId: "fixture-item",
  accessToken: "fixture-token",
};

describe("bank cleanup receipt classification", () => {
  test("missing provider groups are disabled without constructing any SDK", () => {
    for (const provider of [
      "plaid",
      "gocardless",
      "teller",
      "enablebanking",
    ] as const)
      expect(isBankCleanupConfigured(provider, {})).toBe(false);
    expect(
      isBankCleanupConfigured("plaid", {
        PLAID_CLIENT_ID: "fixture",
        PLAID_SECRET: " ",
      }),
    ).toBe(false);
    expect(
      isBankCleanupConfigured("plaid", {
        PLAID_CLIENT_ID: "fixture",
        PLAID_SECRET: "fixture",
      }),
    ).toBe(true);
  });
  test("a resolved provider deletion is the only normal success receipt", async () => {
    expect(await revokeBankConnection(target, async () => undefined)).toEqual({
      status: "completed",
      reason: "revoked",
    });
  });
  test("Plaid documented ITEM_NOT_FOUND settles an already removed item but invalid token does not", async () => {
    const failure = (error_code: string) => async () => {
      throw { response: { status: 400, data: { error_code } } };
    };
    expect(
      await revokeBankConnection(target, failure("ITEM_NOT_FOUND")),
    ).toEqual({ status: "completed", reason: "already_absent" });
    expect(
      await revokeBankConnection(target, failure("INVALID_ACCESS_TOKEN")),
    ).toEqual({ status: "reconciliation", reason: "provider_rejected" });
  });
  test("429 is retryable; 401, 404, 500 and a lost response never claim success", async () => {
    expect(
      await revokeBankConnection(target, async () => {
        throw { response: { status: 429 } };
      }),
    ).toEqual({ status: "pending", reason: "provider_rate_limit" });
    for (const status of [401, 404, 500])
      expect(
        (
          await revokeBankConnection(target, async () => {
            throw { response: { status } };
          })
        ).status,
      ).toBe("reconciliation");
    expect(
      await revokeBankConnection(target, async () => {
        throw new Error("token=must-not-escape");
      }),
    ).toEqual({ status: "reconciliation", reason: "provider_uncertain" });
  });
  test("missing stable identity cannot issue a provider request", async () => {
    const execute = mock(async () => undefined);
    expect(
      (await revokeBankConnection({ ...target, accessToken: null }, execute))
        .reason,
    ).toBe("provider_identity_missing");
    expect(
      (
        await revokeBankConnection(
          { ...target, provider: "gocardless", referenceId: null },
          execute,
        )
      ).reason,
    ).toBe("provider_identity_missing");
    expect(execute).not.toHaveBeenCalled();
  });
  test("actual Teller DELETE rejects resolved failed HTTP responses and accepts 204", async () => {
    let responseStatus = 500;
    const requests: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), method: init?.method });
        expect(init?.signal).toBeDefined();
        return new Response(null, { status: responseStatus });
      },
      { preconnect: forbidden },
    );
    const api = new TellerApi();
    for (const status of [401, 429, 500]) {
      responseStatus = status;
      await expect(
        api.deleteAccounts({ accessToken: "fixture-only" }),
      ).rejects.toMatchObject({ status });
    }
    responseStatus = 204;
    await expect(
      api.deleteAccounts({ accessToken: "fixture-only" }),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(4);
    expect(
      requests.every(
        (request) =>
          request.url === "https://api.teller.io/accounts" &&
          request.method === "delete",
      ),
    ).toBe(true);
  });
});
