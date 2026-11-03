import { describe, expect, mock, spyOn, test } from "bun:test";
import type { InvoiceProviderReconciliationPlan } from "@midday/db/queries";
import type Stripe from "stripe";
import {
  confirmStripeRefundsForWebhook,
  getInvoiceProviderReconciliationProofs,
} from "../services/invoice-provider-reconciliation";

const plan: InvoiceProviderReconciliationPlan = {
  invoiceId: "73edc15c-7f58-42ca-9b25-ad0319f0bd10",
  teamId: "494c4720-6bf3-41b2-820d-59ce91414893",
  revision: "a".repeat(64),
  payments: [
    {
      paymentIntentId: "pi_fixture",
      stripeAccountId: "acct_original",
      amountMinor: 10000,
      currency: "usd",
      refunds: [{ id: "re_fixture", amountMinor: 2000, reversed: false }],
    },
  ],
};
const identity = {
  paymentIntentId: "pi_fixture",
  stripeAccountId: "acct_original",
};
function provider() {
  const intent = {
    id: "pi_fixture",
    status: "succeeded" as const,
    amount: 10000,
    amount_received: 10000,
    currency: "usd",
    metadata: { invoice_id: plan.invoiceId, team_id: plan.teamId },
  };
  const resource = {
    id: "re_fixture",
    status: "succeeded" as string | null,
    amount: 2000,
    currency: "usd",
    payment_intent: "pi_fixture",
    failure_balance_transaction: null as string | null | undefined,
  };
  const retrievePayment = mock(
    async (_id: string, _options: Stripe.RequestOptions) => ({
      ...intent,
    }),
  );
  const retrieveRefund = mock(
    async (_id: string, _options: Stripe.RequestOptions) => ({
      ...resource,
    }),
  );
  const listed = { ...resource };
  const list = mock(
    async (_params: unknown, _options: Stripe.RequestOptions) => ({
      data: [{ ...listed }],
      has_more: false,
    }),
  );
  return {
    intent,
    resource,
    listed,
    retrievePayment,
    retrieveRefund,
    list,
    stripe: {
      paymentIntents: { retrieve: retrievePayment },
      refunds: { retrieve: retrieveRefund, list },
    },
  };
}

describe("exact provider resource verification", () => {
  test("reads the original connected account and exact refund ID even when the list omits a known refund", async () => {
    const f = provider();
    f.list.mockImplementation(async () => ({ data: [], has_more: false }));
    const proofs = await getInvoiceProviderReconciliationProofs(f.stripe, plan);
    expect(f.retrievePayment).toHaveBeenCalledWith("pi_fixture", {
      stripeAccount: "acct_original",
      timeout: expect.any(Number),
    });
    expect(f.retrieveRefund).toHaveBeenCalledWith("re_fixture", {
      stripeAccount: "acct_original",
      timeout: expect.any(Number),
    });
    expect(proofs).toEqual([
      {
        source: "resource_get",
        ...identity,
        amountMinor: 10000,
        currency: "usd",
        refunds: [
          {
            id: "re_fixture",
            amountMinor: 2000,
            status: "succeeded",
            verifiedBy: "resource_get",
            failureBalanceTransactionId: null,
          },
        ],
      },
    ]);
  });
  test("resource_missing and other GET errors never become empty successful proof sets", async () => {
    for (const error of [
      { code: "resource_missing" },
      new Error("fixture transport failure"),
    ]) {
      const f = provider();
      f.retrieveRefund.mockImplementation(async () => {
        throw error;
      });
      await expect(
        getInvoiceProviderReconciliationProofs(f.stripe, plan),
      ).rejects.toMatchObject({ status: 503 });
    }
  });
  test("a changed payment amount or tenant binding cannot verify the original journal", async () => {
    const wrongAmount = provider();
    wrongAmount.intent.amount = 9999;
    wrongAmount.intent.amount_received = 9999;
    await expect(
      getInvoiceProviderReconciliationProofs(wrongAmount.stripe, plan),
    ).rejects.toMatchObject({ status: 409 });
    const wrongTeam = provider();
    wrongTeam.intent.metadata.team_id = "foreign-team";
    await expect(
      getInvoiceProviderReconciliationProofs(wrongTeam.stripe, plan),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("unknown/null refund status, wrong resource identity, amount and currency fail closed", async () => {
    for (const change of [
      { status: null },
      { status: "new_unknown_state" },
      { id: "re_foreign" },
      { payment_intent: "pi_foreign" },
      { currency: "eur" },
      { amount: 0 },
      { amount: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const f = provider();
      Object.assign(f.resource, change);
      await expect(
        getInvoiceProviderReconciliationProofs(f.stripe, plan),
      ).rejects.toMatchObject({ status: 409 });
    }
  });
  test("pending and requires_action remain explicit states for the DB fence; they are not inferred refunds or reversals", async () => {
    for (const status of ["pending", "requires_action"]) {
      const f = provider();
      f.resource.status = status;
      const proofs = await getInvoiceProviderReconciliationProofs(
        f.stripe,
        plan,
      );
      expect(proofs[0]?.refunds[0]).toMatchObject({
        status,
        verifiedBy: "resource_get",
        failureBalanceTransactionId: null,
      });
    }
  });
  test("empty or oversized known-payment plans cannot authorize any provider IO", async () => {
    for (const payments of [
      [],
      Array.from({ length: 17 }, () => plan.payments[0]!),
    ]) {
      const f = provider();
      await expect(
        getInvoiceProviderReconciliationProofs(f.stripe, { ...plan, payments }),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.retrievePayment).not.toHaveBeenCalled();
      expect(f.retrieveRefund).not.toHaveBeenCalled();
    }
  });
  test("all payments and refund pages share one deadline before another request is made", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const f = provider();
      f.retrievePayment.mockImplementation(async (id) => {
        now += 8_000;
        return { ...f.intent, id };
      });
      const twoPayments = {
        ...plan,
        payments: [
          plan.payments[0]!,
          { ...plan.payments[0]!, paymentIntentId: "pi_second", refunds: [] },
        ],
      };
      await expect(
        getInvoiceProviderReconciliationProofs(f.stripe, twoPayments),
      ).rejects.toMatchObject({ status: 503 });
      expect(f.retrievePayment).toHaveBeenCalledTimes(2);
      expect(f.list).toHaveBeenCalledTimes(1);
      expect(f.retrieveRefund).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
  test("the last exact GET receives only the remaining budget and a late result cannot clear uncertainty", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const f = provider();
      f.retrievePayment.mockImplementation(async () => {
        now = 5_000;
        return { ...f.intent };
      });
      f.list.mockImplementation(async () => {
        now = 14_500;
        return { data: [{ ...f.listed }], has_more: false };
      });
      f.retrieveRefund.mockImplementation(async () => {
        now = 15_001;
        return { ...f.resource };
      });
      await expect(
        getInvoiceProviderReconciliationProofs(f.stripe, plan),
      ).rejects.toMatchObject({ status: 503 });
      expect(f.retrievePayment.mock.calls[0]?.[1].timeout).toBe(5_000);
      expect(f.list.mock.calls[0]?.[1].timeout).toBe(5_000);
      expect(f.retrieveRefund.mock.calls[0]?.[1].timeout).toBe(500);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("webhook return-of-funds proof", () => {
  test("unknown and null statuses reach the DB boundary as unconfirmed observations", async () => {
    for (const status of [null, "future_provider_status"]) {
      const f = provider();
      f.listed.status = status;
      const result = await confirmStripeRefundsForWebhook(f.stripe, identity);
      expect(result.refunds).toEqual([
        { id: "re_fixture", amountMinor: 2000, status: status ?? "unknown" },
      ]);
      expect(result.refundedMinor).toBe(0);
      expect(f.retrieveRefund).not.toHaveBeenCalled();
    }
  });
  test("a late failed-list snapshot cannot reverse a resource that now requires customer action", async () => {
    const f = provider();
    f.listed.status = "failed";
    f.resource.status = "requires_action";
    const result = await confirmStripeRefundsForWebhook(f.stripe, identity);
    expect(result.refunds[0]).toMatchObject({
      status: "requires_action",
      verifiedBy: "resource_get",
    });
    expect(f.retrieveRefund).toHaveBeenCalledWith("re_fixture", {
      stripeAccount: "acct_original",
      timeout: expect.any(Number),
    });
  });
  test("a failed exact GET retains unverified evidence for the durable DB marker", async () => {
    const f = provider();
    f.listed.status = "failed";
    f.retrieveRefund.mockImplementation(async () => {
      throw new Error("fixture unavailable");
    });
    const result = await confirmStripeRefundsForWebhook(f.stripe, identity);
    expect(result.refunds[0]).toEqual({
      id: "re_fixture",
      amountMinor: 2000,
      status: "failed",
    });
  });
  test("an omitted or null balance-transaction reference cannot invent return-of-funds evidence", async () => {
    for (const reference of [undefined, null]) {
      const f = provider();
      f.listed.status = "failed";
      f.resource.status = "failed";
      f.resource.failure_balance_transaction = reference;
      const result = await confirmStripeRefundsForWebhook(f.stripe, identity);
      expect(result.refunds[0]).toEqual({
        id: "re_fixture",
        amountMinor: 2000,
        status: "failed",
        verifiedBy: "resource_get",
        failureBalanceTransactionId: null,
      });
      expect(result.refundedMinor).toBe(0);
    }
  });
  test("failed and canceled resources carry the exact returned balance-transaction reference", async () => {
    for (const status of ["failed", "canceled"]) {
      const f = provider();
      f.listed.status = status;
      f.resource.status = status;
      f.resource.failure_balance_transaction = "txn_returnedFixture";
      const result = await confirmStripeRefundsForWebhook(f.stripe, identity);
      expect(result.refunds[0]).toEqual({
        id: "re_fixture",
        amountMinor: 2000,
        status,
        verifiedBy: "resource_get",
        failureBalanceTransactionId: "txn_returnedFixture",
      });
    }
  });
});
