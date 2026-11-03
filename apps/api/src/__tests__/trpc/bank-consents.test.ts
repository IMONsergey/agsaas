import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import type { HostedConsentActor } from "@midday/db/bank-consent";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error(
    "Real provider calls are forbidden in bank consent router tests",
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
const id = "466c958c-c7b4-4427-a746-5cf5a3c41d96";
const sessionId = "3eb9f995-9757-43db-9d0a-6cc7cf563f28";
const requestId = "7f553a4d-e71f-4400-9fbb-6f71c5e291df";
const output = {
  id,
  status: "awaiting_consent",
  expiresAt: "2026-12-01T00:00:00Z",
};
const start = mock(
  async (_db: unknown, _actor: HostedConsentActor, _input: unknown) => output,
);
const complete = mock(async () => output);
const get = mock(async () => output);
const list = mock(async () => [output]);
const cancel = mock(async () => ({ ...output, status: "cleanup_pending" }));
mock.module("@api/services/hosted-bank-consent", () => ({
  startHostedBankConsent: start,
  completeHostedBankConsent: complete,
}));
mock.module("@midday/db/queries/hosted-bank-consents", () => ({
  getHostedBankConsent: get,
  listHostedBankConsents: list,
  cancelHostedBankConsent: cancel,
  hostedBankConsentView: (value: unknown) => value,
}));
const { createCallerFactory } = await import("../../trpc/init");
const { bankConsentsRouter } = await import("../../trpc/routers/bank-consents");
const context = () => {
  const value = createTestContext();
  value.session = { ...value.session, sessionId, aal: "aal2" };
  return value;
};
beforeEach(() => {
  mocks.getTeamMemberRole.mockReset();
  mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("owner"));
  start.mockReset();
  start.mockImplementation(async () => output);
  for (const fn of [complete, get, list, cancel]) fn.mockClear();
});

describe("owner and session bound bank consent routes", () => {
  for (const role of ["member", null]) {
    test(`role ${role} cannot start, resume, inspect or cancel another owner's consent`, async () => {
      mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve(role));
      const caller = createCallerFactory(bankConsentsRouter)(context());
      for (const operation of [
        () => caller.start({ requestId, country: "US" }),
        () => caller.complete({ id }),
        () => caller.cancel({ id }),
        () => caller.get({ id }),
        () => caller.list(),
        () => caller.capability(),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      for (const fn of [start, complete, get, list, cancel])
        expect(fn).not.toHaveBeenCalled();
    });
  }
  test("a current browser session identity is required even for an owner", async () => {
    const value = context();
    delete value.session.sessionId;
    await expect(
      createCallerFactory(bankConsentsRouter)(value).start({
        requestId,
        country: "US",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(start).not.toHaveBeenCalled();
  });
  test("the server derives all actor and assurance fields from the verified context", async () => {
    const value = context();
    await createCallerFactory(bankConsentsRouter)(value).start({
      requestId,
      country: "US",
    });
    expect(start).toHaveBeenCalledWith(
      value.db,
      {
        userId: "test-user-id",
        teamId: "test-team-id",
        sessionId,
        aal: "aal2",
      },
      { requestId, country: "US" },
    );
  });
  test("client credentials, actor overrides and amounts are rejected before provider orchestration", async () => {
    const caller = createCallerFactory(bankConsentsRouter)(context());
    for (const unexpected of [
      { publicToken: "public-sandbox-untrusted" },
      { accessToken: "access-sandbox-untrusted" },
      { teamId: "foreign-team" },
      { sessionId: "foreign-session" },
      { amount: 999999 },
    ]) {
      const input = { requestId, country: "US" as const, ...unexpected };
      await expect(caller.start(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      const completion = { id, ...unexpected };
      await expect(caller.complete(completion)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(start).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
  test("unknown persistence/provider errors cannot disclose raw details", async () => {
    start.mockImplementation(async () => {
      throw new Error("SQL params access-sandbox-private-fixture");
    });
    let failure: unknown;
    try {
      await createCallerFactory(bankConsentsRouter)(context()).start({
        requestId,
        country: "US",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(String(failure)).not.toContain("access-sandbox-private-fixture");
    expect(JSON.stringify(failure)).not.toContain(
      "access-sandbox-private-fixture",
    );
  });
});
