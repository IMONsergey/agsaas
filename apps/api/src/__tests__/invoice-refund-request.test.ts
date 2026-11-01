import { describe, expect, mock, test } from "bun:test";
import type { InvoiceRefundContext } from "@midday/db/queries";
import type Stripe from "stripe";
import {
  getConfirmedFullInvoiceRefund,
  requestInvoiceRefund,
} from "../services/invoice-refund-request";

// Provider seams only. No Stripe client, credentials or network calls.
const context: InvoiceRefundContext = {
  invoiceId: "73edc15c-7f58-42ca-9b25-ad0319f0bd10",
  teamId: "59468837-7f70-4257-b66c-7752d57591c1",
  paymentIntentId: "pi_fixture",
  stripeAccountId: "acct_original",
  amountMinor: 12005,
  currency: "usd",
};
type Intent = Pick<
  Stripe.PaymentIntent,
  "id" | "status" | "amount" | "amount_received" | "currency" | "metadata"
>;
type Refund = Pick<
  Stripe.Refund,
  "id" | "status" | "amount" | "currency" | "payment_intent"
>;
function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: context.paymentIntentId,
    status: "succeeded",
    amount: 12005,
    amount_received: 12005,
    currency: "usd",
    metadata: { invoice_id: context.invoiceId, team_id: context.teamId },
    ...overrides,
  };
}
function refund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: "re_fixture",
    status: "succeeded",
    amount: 12005,
    currency: "usd",
    payment_intent: context.paymentIntentId,
    ...overrides,
  };
}
function provider() {
  return {
    paymentIntents: {
      retrieve: mock(async (_id: string, _options: Stripe.RequestOptions) =>
        intent(),
      ),
    },
    refunds: {
      create: mock(
        async (
          _params: Stripe.RefundCreateParams,
          _options: Stripe.RequestOptions,
        ) => refund(),
      ),
      list: mock(
        async (
          _params: Stripe.RefundListParams,
          _options: Stripe.RequestOptions,
        ): Promise<{ data: Refund[]; has_more: boolean }> => ({
          data: [refund()],
          has_more: false,
        }),
      ),
    },
  };
}

describe("invoice refund requests are acknowledgments, not completed refunds", () => {
  for (const status of ["succeeded", "pending", "requires_action"] as const) {
    test(`${status} acknowledges the request without claiming the invoice is refunded`, async () => {
      const stripe = provider();
      stripe.refunds.create.mockImplementation(async () => refund({ status }));
      expect(await requestInvoiceRefund(context, stripe)).toEqual({
        accepted: true,
        status: "requested",
        refundStatus: status,
        refundId: "re_fixture",
      });
      expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith(
        "pi_fixture",
        { stripeAccount: "acct_original" },
      );
      expect(stripe.refunds.create).toHaveBeenCalledWith(
        { payment_intent: "pi_fixture" },
        {
          stripeAccount: "acct_original",
          idempotencyKey: `invoice-refund/${context.invoiceId}/pi_fixture/full/v1`,
        },
      );
    });
  }
  test("retry uses the identical original account and full-remaining-refund key", async () => {
    const stripe = provider();
    await requestInvoiceRefund(context, stripe);
    await requestInvoiceRefund(context, stripe);
    expect(stripe.refunds.create.mock.calls[0]).toEqual(
      stripe.refunds.create.mock.calls[1],
    );
  });
  test("supports non-card pyr_ refund IDs and a remaining partial amount", async () => {
    const stripe = provider();
    stripe.refunds.create.mockImplementation(async () =>
      refund({ id: "pyr_fixture", amount: 1000 }),
    );
    expect(await requestInvoiceRefund(context, stripe)).toMatchObject({
      refundId: "pyr_fixture",
      status: "requested",
    });
  });
  for (const override of [
    { id: "pi_foreign" },
    { status: "processing" as const },
    { amount: 12004 },
    { amount_received: 12004 },
    { currency: "eur" },
    { metadata: { invoice_id: context.invoiceId, team_id: "foreign" } },
    { metadata: { invoice_id: "foreign", team_id: context.teamId } },
  ]) {
    test(`rejects original payment mismatch before any refund request: ${JSON.stringify(override)}`, async () => {
      const stripe = provider();
      stripe.paymentIntents.retrieve.mockImplementation(async () =>
        intent(override),
      );
      await expect(requestInvoiceRefund(context, stripe)).rejects.toMatchObject(
        { status: 409 },
      );
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    });
  }
  for (const override of [
    { id: "invalid" },
    { payment_intent: "pi_foreign" },
    { currency: "eur" },
    { amount: 12006 },
    { amount: 0 },
    { amount: 1.5 },
    { status: "failed" as const },
    { status: "canceled" as const },
    { status: null },
  ]) {
    test(`does not claim completion from an invalid refund acknowledgment: ${JSON.stringify(override)}`, async () => {
      const stripe = provider();
      stripe.refunds.create.mockImplementation(async () => refund(override));
      await expect(requestInvoiceRefund(context, stripe)).rejects.toMatchObject(
        { status: 409 },
      );
    });
  }
  test("unknown provider outcome is retryable without exposing provider payloads", async () => {
    const stripe = provider();
    stripe.refunds.create.mockImplementation(async () => {
      throw new Error("pi_fixture_secret_private");
    });
    await expect(requestInvoiceRefund(context, stripe)).rejects.toMatchObject({
      status: 503,
    });
    try {
      await requestInvoiceRefund(context, stripe);
    } catch (error) {
      expect(String(error)).not.toContain("secret_private");
    }
  });
  for (const code of ["charge_already_refunded", "resource_missing"]) {
    test(`${code} requires reconciliation instead of a new payment/refund identity`, async () => {
      const stripe = provider();
      stripe.refunds.create.mockImplementation(async () => {
        throw { code };
      });
      await expect(requestInvoiceRefund(context, stripe)).rejects.toMatchObject(
        { status: 409 },
      );
    });
  }
});

describe("full invoice refund confirmation reads complete current succeeded refunds", () => {
  test("confirms only an exact succeeded total on the original account and intent", async () => {
    const stripe = provider();
    expect(await getConfirmedFullInvoiceRefund(stripe, context)).toEqual({
      paymentIntentId: "pi_fixture",
      amountMinor: 12005,
      currency: "usd",
      candidateIdentity: {
        invoiceId: context.invoiceId,
        teamId: context.teamId,
        reservationId: undefined,
      },
    });
    expect(stripe.refunds.list).toHaveBeenCalledWith(
      { payment_intent: "pi_fixture", limit: 100 },
      { stripeAccount: "acct_original" },
    );
  });
  for (const status of [
    "pending",
    "failed",
    "requires_action",
    "canceled",
  ] as const) {
    test(`${status} refund is not counted as succeeded even for the full amount`, async () => {
      const stripe = provider();
      stripe.refunds.list.mockImplementation(async () => ({
        data: [refund({ status })],
        has_more: false,
      }));
      expect(await getConfirmedFullInvoiceRefund(stripe, context)).toBeNull();
    });
  }
  test("a succeeded partial refund does not finalize the invoice", async () => {
    const stripe = provider();
    stripe.refunds.list.mockImplementation(async () => ({
      data: [refund({ amount: 12004 })],
      has_more: false,
    }));
    expect(await getConfirmedFullInvoiceRefund(stripe, context)).toBeNull();
  });
  test("follows all pages and counts only succeeded entries", async () => {
    const stripe = provider();
    stripe.refunds.list.mockImplementationOnce(async () => ({
      data: [
        refund({ id: "re_first", amount: 1000 }),
        refund({ id: "re_failed", amount: 12005, status: "failed" }),
      ],
      has_more: true,
    }));
    stripe.refunds.list.mockImplementationOnce(async () => ({
      data: [refund({ id: "pyr_rest", amount: 11005 })],
      has_more: false,
    }));
    expect(await getConfirmedFullInvoiceRefund(stripe, context)).toMatchObject({
      amountMinor: 12005,
    });
    expect(stripe.refunds.list.mock.calls[1]?.[0]).toEqual({
      payment_intent: "pi_fixture",
      limit: 100,
      starting_after: "re_failed",
    });
  });
  test("does not assume completeness when the first page already equals the invoice", async () => {
    const stripe = provider();
    stripe.refunds.list.mockImplementationOnce(async () => ({
      data: [refund()],
      has_more: true,
    }));
    stripe.refunds.list.mockImplementationOnce(async () => {
      throw new Error("provider unavailable");
    });
    await expect(
      getConfirmedFullInvoiceRefund(stripe, context),
    ).rejects.toThrow();
    expect(stripe.refunds.list).toHaveBeenCalledTimes(2);
  });
  for (const override of [
    { payment_intent: "pi_foreign" },
    { currency: "eur" },
    { amount: 1.5 },
    { amount: 0 },
    { id: "invalid" },
  ]) {
    test(`rejects an unbound refund entry: ${JSON.stringify(override)}`, async () => {
      const stripe = provider();
      stripe.refunds.list.mockImplementation(async () => ({
        data: [refund(override)],
        has_more: false,
      }));
      await expect(
        getConfirmedFullInvoiceRefund(stripe, context),
      ).rejects.toMatchObject({ status: 409 });
    });
  }
  test("duplicate entries across pages cannot inflate the succeeded total", async () => {
    const stripe = provider();
    stripe.refunds.list.mockImplementationOnce(async () => ({
      data: [refund({ amount: 6000 })],
      has_more: true,
    }));
    stripe.refunds.list.mockImplementationOnce(async () => ({
      data: [refund({ amount: 6000 })],
      has_more: false,
    }));
    await expect(
      getConfirmedFullInvoiceRefund(stripe, context),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("refunds totaling more than the original payment fail closed", async () => {
    const stripe = provider();
    stripe.refunds.list.mockImplementation(async () => ({
      data: [refund(), refund({ id: "re_excess", amount: 1 })],
      has_more: false,
    }));
    await expect(
      getConfirmedFullInvoiceRefund(stripe, context),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("an empty incomplete page is not confirmation", async () => {
    const stripe = provider();
    stripe.refunds.list.mockImplementation(async () => ({
      data: [],
      has_more: true,
    }));
    await expect(
      getConfirmedFullInvoiceRefund(stripe, context),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("exceeding five pages requires explicit reconciliation, not a partial-history conclusion", async () => {
    const stripe = provider();
    let page = 0;
    stripe.refunds.list.mockImplementation(async () => ({
      data: [refund({ id: `re_page${++page}`, amount: 1 })],
      has_more: true,
    }));
    await expect(
      getConfirmedFullInvoiceRefund(stripe, context),
    ).rejects.toMatchObject({ status: 409 });
    expect(stripe.refunds.list).toHaveBeenCalledTimes(5);
  });
  test("non-succeeded or short original payment cannot be declared fully refunded", async () => {
    const stripe = provider();
    stripe.paymentIntents.retrieve.mockImplementation(async () =>
      intent({ amount_received: 12004 }),
    );
    await expect(
      getConfirmedFullInvoiceRefund(stripe, context),
    ).rejects.toMatchObject({ status: 409 });
    expect(stripe.refunds.list).not.toHaveBeenCalled();
  });
});
