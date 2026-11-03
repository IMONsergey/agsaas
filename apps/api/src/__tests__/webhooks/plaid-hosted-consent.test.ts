import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";

const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error(
    "Real network calls are forbidden in Hosted Link webhook tests",
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
const validate = mock(async () => true);
const lookup = mock(async () => {
  throw new Error("A Link delivery must not select a bank connection");
});
const mutate = mock(async () => {
  throw new Error("A Link delivery must not mutate or exchange a grant");
});
const logs: unknown[] = [];
mock.module("@api/utils/plaid", () => ({ validatePlaidWebhook: validate }));
mock.module("@midday/db/queries", () => ({
  getBankConnectionByReferenceId: lookup,
  updateBankConnectionStatus: mutate,
  deleteTransactionsByInternalIds: mutate,
}));
mock.module("@midday/db/queries/bank-sync", () => ({
  requestBankSync: mutate,
}));
mock.module("@midday/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => logs.push(args),
    info: (...args: unknown[]) => logs.push(args),
  },
}));
const { plaidWebhookRouter } = await import(
  "../../rest/routers/webhooks/plaid"
);
const payload = {
  webhook_type: "LINK",
  webhook_code: "SESSION_FINISHED",
  link_token: "link-sandbox-private-fixture",
  link_session_id: "link-session-fixture",
  public_tokens: ["public-sandbox-private-fixture"],
  status: "success",
  environment: "sandbox",
};
const request = (body = payload) =>
  plaidWebhookRouter.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "plaid-verification": "signature-fixture",
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  validate.mockReset();
  validate.mockImplementation(async () => true);
  lookup.mockClear();
  mutate.mockClear();
  logs.length = 0;
});

describe("Hosted Link webhook acknowledgement", () => {
  test("unverified delivery cannot reach the acknowledgement path", async () => {
    validate.mockImplementation(async () => false);
    const response = await request();
    expect(response.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
  test("signed delivery is acknowledged without accepting tokens, loading a tenant or logging credentials", async () => {
    for (const webhook_code of [
      "SESSION_FINISHED",
      "ITEM_ADD_RESULT",
      "EVENTS",
    ]) {
      const response = await request({ ...payload, webhook_code });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
    }
    expect(validate).toHaveBeenCalledTimes(3);
    expect(lookup).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(JSON.stringify(logs)).not.toContain(payload.link_token);
    expect(JSON.stringify(logs)).not.toContain(payload.public_tokens[0]!);
  });
  test("an unknown Link message is not mistaken for a supported delivery", async () => {
    const response = await request({ ...payload, webhook_code: "UNKNOWN" });
    expect(response.status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
