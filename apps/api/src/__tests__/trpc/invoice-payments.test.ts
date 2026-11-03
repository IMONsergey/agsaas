import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { InvoicePaymentError } from "@midday/db/errors";
import type { invoiceRefundRequestView } from "@midday/db/invoice-refund-request";
import { createCallerFactory } from "../../trpc/init";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const invoiceId = "73edc15c-7f58-42ca-9b25-ad0319f0bd10";
const retrievePayment = mock(async () => ({
  id: "pi_fixture",
  amount: 12005,
  amount_received: 12005,
  currency: "usd",
  status: "succeeded",
  metadata: { invoice_id: invoiceId, team_id: "test-team-id" },
}));
const requestRefund = mock(async () => ({
  id: "re_fixture",
  amount: 12005,
  currency: "usd",
  payment_intent: "pi_fixture",
  status: "pending",
}));
mock.module("stripe", () => ({
  default: class {
    paymentIntents = { retrieve: retrievePayment };
    refunds = { create: requestRefund };
  },
}));
const operationId = "8c249b32-8fb7-4dbf-b8b7-5861ef310b77";
const requestId = "e869de01-3d70-40ee-9ac5-ddb5cb5fb41f";
const receipt: ReturnType<typeof invoiceRefundRequestView> = {
  requestId,
  state: "bound",
  refundStatus: "pending",
  amountMinor: "12005",
  currency: "usd",
  createdAt: "2026-11-03T10:00:00Z",
  knownResource: true,
  accepted: true,
  status: "requested",
};
const durableRequest = mock(
  async (_db: unknown, _provider: unknown, _scope: Record<string, string>) =>
    receipt,
);
const durableResume = mock(
  async (_db: unknown, _provider: unknown, _scope: Record<string, string>) =>
    receipt,
);
mock.module("@api/services/invoice-refund-intents", () => ({
  requestDurableInvoiceRefund: durableRequest,
  resumeDurableInvoiceRefund: durableResume,
}));
const { invoicePaymentsRouter } = await import(
  "../../trpc/routers/invoice-payments"
);
const createCaller = createCallerFactory(invoicePaymentsRouter);

beforeEach(() => {
  mocks.getTeamMemberRole.mockReset();
  mocks.getTeamMemberRole.mockImplementation(async () => "owner");
});

describe("tRPC: invoicePayments.stripeStatus", () => {
  beforeEach(() => {
    mocks.getTeamById.mockReset();
    mocks.getTeamById.mockImplementation(() =>
      Promise.resolve({
        id: "test-team-id",
        stripeAccountId: null,
        stripeConnectStatus: null,
      }),
    );
  });

  test("returns disconnected status when Stripe is not linked", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.stripeStatus();

    expect(result).toEqual({
      connected: false,
      status: null,
      stripeAccountId: null,
    });
    expect(mocks.getTeamById).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });

  test("returns connected when team has a Stripe account", async () => {
    mocks.getTeamById.mockImplementation(() =>
      Promise.resolve({
        id: "test-team-id",
        stripeAccountId: "acct_123",
        stripeConnectStatus: "active",
      }),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.stripeStatus();

    expect(result).toEqual({
      connected: true,
      status: "active",
      stripeAccountId: "acct_123",
    });
  });

  test("throws when team id is missing from context", async () => {
    mocks.simulateMissingTeamOnce();

    const caller = createCaller(createTestContext());

    await expect(caller.stripeStatus()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mocks.getTeamById).not.toHaveBeenCalled();
  });
});

describe("tRPC: invoicePayments.getConnectUrl", () => {
  const envKeys = [
    "API_URL",
    "MIDDAY_API_URL",
    "NEXT_PUBLIC_API_URL",
    "NODE_ENV",
  ] as const;
  let saved: Array<[string, string | undefined]>;
  beforeEach(() => {
    saved = envKeys.map((key) => [key, process.env[key]]);
    process.env.API_URL = "https://api.agsaas.example";
  });
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  test("returns REST connect URL string", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.getConnectUrl();

    expect(result).toBe(
      "https://api.agsaas.example/invoice-payments/connect-stripe",
    );
  });

  test("refuses routing Stripe connection through an upstream origin", async () => {
    process.env.API_URL = "https://api.midday.ai";
    const caller = createCaller(createTestContext());
    await expect(caller.getConnectUrl()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  test("production cannot silently invent an API origin", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.API_URL;
    delete process.env.MIDDAY_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    const caller = createCaller(createTestContext());
    await expect(caller.getConnectUrl()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  test("throws when team id is missing from context", async () => {
    mocks.simulateMissingTeamOnce();
    const caller = createCaller(createTestContext());

    // The session is authenticated; no workspace means it has no owner grant.
    await expect(caller.getConnectUrl()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.getTeamMemberRole).not.toHaveBeenCalled();
  });
});

describe("tRPC: invoicePayments.disconnectStripe", () => {
  const receipt = {
    success: true,
    cleanupPending: true,
    cleanupId: "f5418c2c-7595-4a41-8daf-008482ac8016",
  };
  beforeEach(() => {
    mocks.requestStripeDisconnect.mockReset();
    mocks.requestStripeDisconnect.mockImplementation(async () => receipt);
    mocks.getTeamById.mockClear();
    mocks.updateTeam.mockClear();
  });

  test("returns durable cleanup receipt and binds the authenticated actor", async () => {
    const caller = createCaller(createTestContext());
    expect(await caller.disconnectStripe()).toEqual(receipt);
    expect(mocks.requestStripeDisconnect).toHaveBeenCalledWith(
      expect.anything(),
      { teamId: "test-team-id", actorUserId: "test-user-id" },
    );
    expect(mocks.getTeamById).not.toHaveBeenCalled();
    expect(mocks.updateTeam).not.toHaveBeenCalled();
  });

  test("preserves completed cleanup instead of inventing pending work", async () => {
    const completed = { success: true, cleanupPending: false, cleanupId: null };
    mocks.requestStripeDisconnect.mockImplementation(async () => completed);
    const caller = createCaller(createTestContext());
    expect(await caller.disconnectStripe()).toEqual(completed);
  });

  test("a member cannot create the cleanup intent", async () => {
    mocks.getTeamMemberRole.mockImplementation(async () => "member");
    const caller = createCaller(createTestContext());
    await expect(caller.disconnectStripe()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.requestStripeDisconnect).not.toHaveBeenCalled();
    expect(mocks.updateTeam).not.toHaveBeenCalled();
  });

  test("persistence failure cannot report successful disconnection or use a direct-write fallback", async () => {
    mocks.requestStripeDisconnect.mockImplementation(async () => {
      throw new Error("fixture cleanup persistence failure");
    });
    const caller = createCaller(createTestContext());
    await expect(caller.disconnectStripe()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(mocks.updateTeam).not.toHaveBeenCalled();
  });
});

describe("tRPC: durable invoice refund requests", () => {
  beforeEach(() => {
    durableRequest.mockReset();
    durableRequest.mockImplementation(async () => receipt);
    durableResume.mockReset();
    durableResume.mockImplementation(async () => receipt);
    mocks.updateInvoice.mockClear();
    retrievePayment.mockClear();
    requestRefund.mockClear();
  });

  test("a new request binds the authenticated owner and caller operation identity", async () => {
    const caller = createCaller(createTestContext());
    expect(await caller.refundPayment({ invoiceId, operationId })).toEqual(
      receipt,
    );
    expect(durableRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        invoiceId,
        operationId,
        teamId: "test-team-id",
        actorId: "test-user-id",
      },
    );
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(requestRefund).not.toHaveBeenCalled();
  });

  test("resume keeps the original request identity and uses the current owner", async () => {
    const caller = createCaller(createTestContext());
    expect(await caller.resumeRefundRequest({ invoiceId, requestId })).toEqual(
      receipt,
    );
    expect(durableResume).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        invoiceId,
        requestId,
        teamId: "test-team-id",
        actorId: "test-user-id",
      },
    );
    expect(durableRequest).not.toHaveBeenCalled();
  });

  for (const [status, code] of [
    [400, "BAD_REQUEST"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [503, "INTERNAL_SERVER_ERROR"],
  ] as const) {
    test(`preserves a ${status} durable request rejection`, async () => {
      durableRequest.mockImplementation(async () => {
        throw new InvoicePaymentError(status, "Fixture rejection");
      });
      const caller = createCaller(createTestContext());
      await expect(
        caller.refundPayment({ invoiceId, operationId }),
      ).rejects.toMatchObject({ code });
      expect(requestRefund).not.toHaveBeenCalled();
      expect(mocks.updateInvoice).not.toHaveBeenCalled();
    });
  }

  test("a demotion discovered by finalization remains forbidden", async () => {
    durableResume.mockImplementation(async () => {
      throw new InvoicePaymentError(403, "Owner permission changed");
    });
    const caller = createCaller(createTestContext());
    await expect(
      caller.resumeRefundRequest({ invoiceId, requestId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  for (const role of ["member", null]) {
    test(`role ${role} cannot create or resume a money request`, async () => {
      mocks.getTeamMemberRole.mockImplementation(async () => role);
      const caller = createCaller(createTestContext());
      await expect(
        caller.refundPayment({ invoiceId, operationId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller.resumeRefundRequest({ invoiceId, requestId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(durableRequest).not.toHaveBeenCalled();
      expect(durableResume).not.toHaveBeenCalled();
    });
  }

  test("missing workspace cannot request a refund for a supplied invoice ID", async () => {
    mocks.simulateMissingTeamOnce();
    const caller = createCaller(createTestContext());
    await expect(
      caller.refundPayment({ invoiceId, operationId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.getTeamMemberRole).not.toHaveBeenCalled();
    expect(durableRequest).not.toHaveBeenCalled();
    expect(requestRefund).not.toHaveBeenCalled();
  });

  test("strict inputs reject forged provider account, actor and amount before intent creation", async () => {
    const caller = createCaller(createTestContext());
    const forged = {
      invoiceId,
      operationId,
      actorId: "foreign-owner",
      stripeAccountId: "acct_other",
      amountMinor: "1",
    };
    await expect(caller.refundPayment(forged)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(durableRequest).not.toHaveBeenCalled();
  });

  test("strict resume cannot accept caller-supplied provider proof", async () => {
    const caller = createCaller(createTestContext());
    const forged = {
      invoiceId,
      requestId,
      providerRefundId: "re_forged",
      status: "succeeded",
    };
    await expect(caller.resumeRefundRequest(forged)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(durableResume).not.toHaveBeenCalled();
  });
});
