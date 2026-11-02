import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InvoicePaymentError } from "@midday/db/errors";
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
const { invoicePaymentsRouter } = await import(
  "../../trpc/routers/invoice-payments"
);
const createCaller = createCallerFactory(invoicePaymentsRouter);

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
  test("returns REST connect URL string", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.getConnectUrl();

    expect(result).toBe(
      `${process.env.MIDDAY_API_URL ?? "https://api.midday.ai"}/invoice-payments/connect-stripe`,
    );
  });

  test("throws when team id is missing from context", async () => {
    mocks.simulateMissingTeamOnce();
    const caller = createCaller(createTestContext());

    await expect(caller.getConnectUrl()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("tRPC: invoicePayments.disconnectStripe", () => {
  beforeEach(() => {
    mocks.getTeamById.mockReset();
    mocks.updateTeam.mockReset();
    mocks.getTeamById.mockImplementation(() =>
      Promise.resolve({
        id: "test-team-id",
        stripeAccountId: null,
        stripeConnectStatus: null,
      }),
    );
    mocks.updateTeam.mockImplementation(() => Promise.resolve({}));
  });

  test("clears Stripe fields via getTeamById and updateTeamById", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.disconnectStripe();

    expect(result).toEqual({ success: true });
    expect(mocks.getTeamById).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
    expect(mocks.updateTeam).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "test-team-id",
        data: {
          stripeAccountId: null,
          stripeConnectStatus: null,
        },
      }),
    );
  });
});

describe("tRPC: invoicePayments.refundPayment", () => {
  beforeEach(() => {
    mocks.getInvoiceRefundContext.mockReset();
    mocks.updateInvoice.mockClear();
    retrievePayment.mockClear();
    requestRefund.mockClear();
    mocks.getInvoiceRefundContext.mockImplementation(async () => ({
      invoiceId,
      teamId: "test-team-id",
      paymentIntentId: "pi_fixture",
      stripeAccountId: "acct_original",
      amountMinor: 12005,
      currency: "usd",
    }));
    requestRefund.mockImplementation(async () => ({
      id: "re_fixture",
      amount: 12005,
      currency: "usd",
      payment_intent: "pi_fixture",
      status: "pending",
    }));
  });

  test("pending refund is acknowledged without changing invoice financial state", async () => {
    const caller = createCaller(createTestContext());
    expect(await caller.refundPayment({ invoiceId })).toEqual({
      accepted: true,
      status: "requested",
      refundStatus: "pending",
      refundId: "re_fixture",
    });
    expect(mocks.getInvoiceRefundContext).toHaveBeenCalledWith(
      expect.anything(),
      { invoiceId, teamId: "test-team-id" },
    );
    expect(requestRefund).toHaveBeenCalledWith(
      { payment_intent: "pi_fixture" },
      {
        stripeAccount: "acct_original",
        idempotencyKey: `invoice-refund/${invoiceId}/pi_fixture/full/v1`,
      },
    );
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
  });

  for (const [status, code] of [
    [400, "BAD_REQUEST"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [503, "INTERNAL_SERVER_ERROR"],
  ] as const) {
    test(`preserves a ${status} context rejection and never reaches Stripe`, async () => {
      mocks.getInvoiceRefundContext.mockImplementation(async () => {
        throw new InvoicePaymentError(status, "Fixture rejection");
      });
      const caller = createCaller(createTestContext());
      await expect(caller.refundPayment({ invoiceId })).rejects.toMatchObject({
        code,
      });
      expect(retrievePayment).not.toHaveBeenCalled();
      expect(requestRefund).not.toHaveBeenCalled();
    });
  }

  test("missing team cannot request a refund for a supplied invoice ID", async () => {
    mocks.simulateMissingTeamOnce();
    const caller = createCaller(createTestContext());
    await expect(caller.refundPayment({ invoiceId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mocks.getInvoiceRefundContext).not.toHaveBeenCalled();
    expect(requestRefund).not.toHaveBeenCalled();
  });

  test("failed provider refund is a conflict, not completed financial history", async () => {
    requestRefund.mockImplementation(async () => ({
      id: "re_fixture",
      amount: 12005,
      currency: "usd",
      payment_intent: "pi_fixture",
      status: "failed",
    }));
    const caller = createCaller(createTestContext());
    await expect(caller.refundPayment({ invoiceId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
  });
});
