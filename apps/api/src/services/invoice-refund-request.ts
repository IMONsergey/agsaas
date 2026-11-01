import { InvoicePaymentError } from "@midday/db/errors";
import type { InvoiceRefundContext } from "@midday/db/queries";
import type Stripe from "stripe";

type RefundProvider = {
  paymentIntents: {
    retrieve(
      id: string,
      options: Stripe.RequestOptions,
    ): Promise<
      Pick<
        Stripe.PaymentIntent,
        "id" | "status" | "amount" | "amount_received" | "currency" | "metadata"
      >
    >;
  };
  refunds: {
    create(
      params: Stripe.RefundCreateParams,
      options: Stripe.RequestOptions,
    ): Promise<
      Pick<
        Stripe.Refund,
        "id" | "status" | "amount" | "currency" | "payment_intent"
      >
    >;
  };
};

/**
 * Requests the remaining full refund. Acceptance is not a completed invoice
 * refund: only a webhook with current complete succeeded-refund confirmation
 * changes that state. Provider success is not irreversible settlement.
 */
export async function requestInvoiceRefund(
  context: InvoiceRefundContext,
  stripe: RefundProvider,
) {
  const options = { stripeAccount: context.stripeAccountId };
  try {
    const intent = await stripe.paymentIntents.retrieve(
      context.paymentIntentId,
      options,
    );
    if (
      intent.id !== context.paymentIntentId ||
      intent.status !== "succeeded" ||
      intent.amount !== context.amountMinor ||
      intent.amount_received !== context.amountMinor ||
      intent.currency !== context.currency ||
      intent.metadata?.invoice_id !== context.invoiceId ||
      intent.metadata?.team_id !== context.teamId
    )
      throw new InvoicePaymentError(
        409,
        "Original payment does not match this invoice",
      );

    const refund = await stripe.refunds.create(
      { payment_intent: context.paymentIntentId },
      {
        ...options,
        idempotencyKey: `invoice-refund/${context.invoiceId}/${context.paymentIntentId}/full/v1`,
      },
    );
    const intentId =
      typeof refund.payment_intent === "string"
        ? refund.payment_intent
        : refund.payment_intent?.id;
    if (
      !/^(re|pyr)_[A-Za-z0-9]+$/.test(refund.id) ||
      intentId !== context.paymentIntentId ||
      refund.currency !== context.currency ||
      !Number.isSafeInteger(refund.amount) ||
      refund.amount <= 0 ||
      refund.amount > context.amountMinor
    ) {
      throw new InvoicePaymentError(
        409,
        "Refund response requires reconciliation",
      );
    }
    switch (refund.status) {
      case "succeeded":
      case "pending":
      case "requires_action":
        return {
          accepted: true as const,
          status: "requested" as const,
          refundStatus: refund.status,
          refundId: refund.id,
        };
      default:
        throw new InvoicePaymentError(
          409,
          "Refund was not completed; reconciliation is required",
        );
    }
  } catch (error) {
    if (error instanceof InvoicePaymentError) throw error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "charge_already_refunded" ||
        error.code === "resource_missing")
    ) {
      throw new InvoicePaymentError(
        409,
        "Original payment or refund requires reconciliation",
      );
    }
    throw new InvoicePaymentError(
      503,
      "Refund confirmation is pending; verify the existing payment before retrying",
    );
  }
}

type RefundStateProvider = Pick<RefundProvider, "paymentIntents"> & {
  refunds: {
    list(
      params: Stripe.RefundListParams,
      options: Stripe.RequestOptions,
    ): Promise<{
      data: Array<
        Pick<
          Stripe.Refund,
          "id" | "status" | "amount" | "currency" | "payment_intent"
        >
      >;
      has_more: boolean;
    }>;
  };
};

/**
 * charge.refunded is not proof that each refund succeeded. Confirm the current
 * complete refund list, including asynchronous refund.updated notifications.
 * This is current provider state, not irreversible settlement or a local ledger.
 */
export async function getConfirmedFullInvoiceRefund(
  stripe: RefundStateProvider,
  params: { paymentIntentId: string; stripeAccountId: string },
) {
  const started = performance.now();
  const options = { stripeAccount: params.stripeAccountId };
  const intent = await stripe.paymentIntents.retrieve(
    params.paymentIntentId,
    options,
  );
  if (
    intent.id !== params.paymentIntentId ||
    intent.status !== "succeeded" ||
    !Number.isSafeInteger(intent.amount_received) ||
    intent.amount_received <= 0 ||
    intent.amount !== intent.amount_received
  ) {
    throw new InvoicePaymentError(
      409,
      "Refund payment state requires reconciliation",
    );
  }
  let startingAfter: string | undefined;
  let succeeded = 0;
  const seen = new Set<string>();
  for (let page = 0; page < 5; page++) {
    if (performance.now() - started > 15_000) {
      throw new InvoicePaymentError(
        503,
        "Refund confirmation exceeded its processing budget",
      );
    }
    const refunds = await stripe.refunds.list(
      {
        payment_intent: params.paymentIntentId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      options,
    );
    if (!Array.isArray(refunds.data) || typeof refunds.has_more !== "boolean") {
      throw new InvoicePaymentError(409, "Refund list requires reconciliation");
    }
    for (const refund of refunds.data) {
      const intentId =
        typeof refund.payment_intent === "string"
          ? refund.payment_intent
          : refund.payment_intent?.id;
      if (
        !/^(re|pyr)_[A-Za-z0-9]+$/.test(refund.id) ||
        seen.has(refund.id) ||
        intentId !== params.paymentIntentId ||
        refund.currency !== intent.currency ||
        !Number.isSafeInteger(refund.amount) ||
        refund.amount <= 0
      ) {
        throw new InvoicePaymentError(
          409,
          "Refund list does not match the payment",
        );
      }
      seen.add(refund.id);
      if (refund.status === "succeeded") succeeded += refund.amount;
    }
    if (succeeded > intent.amount_received) {
      throw new InvoicePaymentError(
        409,
        "Refund total exceeds the original payment",
      );
    }
    if (!refunds.has_more) {
      return succeeded === intent.amount_received
        ? {
            paymentIntentId: intent.id,
            amountMinor: succeeded,
            currency: intent.currency,
            // These editable provider fields identify a candidate only. The
            // webhook must validate UUID shape and the DB must authorize the
            // exact original account/intent/reservation before any mutation.
            candidateIdentity: {
              invoiceId: intent.metadata?.invoice_id,
              teamId: intent.metadata?.team_id,
              reservationId: intent.metadata?.payment_reservation_id,
            },
          }
        : null;
    }
    startingAfter = refunds.data.at(-1)?.id;
    if (!startingAfter)
      throw new InvoicePaymentError(409, "Incomplete refund pagination");
  }
  throw new InvoicePaymentError(
    409,
    "Refund history exceeds automatic reconciliation limits",
  );
}
