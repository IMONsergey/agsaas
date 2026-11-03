import { InvoicePaymentError } from "@midday/db/errors";
import type {
  InvoiceProviderReconciliationPlan,
  InvoiceProviderReconciliationProof,
  StripeRefundEvidence,
} from "@midday/db/queries";
import type Stripe from "stripe";
import {
  getConfirmedInvoiceRefunds,
  type RefundStateProvider,
  stripeRefundReadOptions,
} from "./invoice-refund-request";

type RefundResource = Pick<
  Stripe.Refund,
  | "id"
  | "payment_intent"
  | "amount"
  | "currency"
  | "status"
  | "failure_balance_transaction"
>;
export type RefundVerificationProvider = RefundStateProvider & {
  refunds: {
    retrieve(
      id: string,
      options: Stripe.RequestOptions,
    ): Promise<RefundResource>;
  };
};

function verifiedRefund(
  refund: RefundResource,
  expected: {
    id: string;
    paymentIntentId: string;
    currency: string;
    maximumMinor: number;
  },
): StripeRefundEvidence {
  const intentId =
    typeof refund.payment_intent === "string"
      ? refund.payment_intent
      : refund.payment_intent?.id;
  if (
    refund.id !== expected.id ||
    intentId !== expected.paymentIntentId ||
    refund.currency !== expected.currency ||
    !Number.isSafeInteger(refund.amount) ||
    refund.amount <= 0 ||
    refund.amount > expected.maximumMinor ||
    !["succeeded", "pending", "requires_action", "failed", "canceled"].includes(
      refund.status ?? "",
    )
  )
    throw new InvoicePaymentError(
      409,
      "Exact refund resource does not establish the expected payment state",
    );
  return {
    id: refund.id,
    amountMinor: refund.amount,
    status: refund.status!,
    verifiedBy: "resource_get",
    failureBalanceTransactionId:
      typeof refund.failure_balance_transaction === "string"
        ? refund.failure_balance_transaction
        : (refund.failure_balance_transaction?.id ?? null),
  };
}

/** A failed list entry alone cannot reverse a previously confirmed refund. */
export async function confirmStripeRefundsForWebhook(
  stripe: RefundVerificationProvider,
  params: { paymentIntentId: string; stripeAccountId: string },
) {
  const deadline = performance.now() + 15_000;
  const confirmation = await getConfirmedInvoiceRefunds(
    stripe,
    params,
    deadline,
    { preserveUnknownStatuses: true },
  );
  const refunds: StripeRefundEvidence[] = [];
  for (const refund of confirmation.refunds) {
    if (
      !["failed", "canceled"].includes(refund.status) ||
      performance.now() > deadline
    ) {
      refunds.push(refund);
      continue;
    }
    try {
      const exact = verifiedRefund(
        await stripe.refunds.retrieve(
          refund.id,
          stripeRefundReadOptions(params.stripeAccountId, deadline),
        ),
        {
          id: refund.id,
          paymentIntentId: params.paymentIntentId,
          currency: confirmation.currency,
          maximumMinor: confirmation.amountMinor,
        },
      );
      // A request that outlived the shared budget is not accepted as fresh proof.
      refunds.push(performance.now() > deadline ? refund : exact);
    } catch {
      // The DB adapter records durable uncertainty for an existing journal refund.
      // Keep this entry unverified; never synthesize return-of-funds evidence.
      refunds.push(refund);
    }
  }
  return { ...confirmation, refunds };
}

/** Verify every known resource, with complete refund discovery and no database lock. */
export async function getInvoiceProviderReconciliationProofs(
  stripe: RefundVerificationProvider,
  plan: InvoiceProviderReconciliationPlan,
): Promise<InvoiceProviderReconciliationProof[]> {
  const deadline = performance.now() + 15_000;
  function withinBudget() {
    if (performance.now() > deadline)
      throw new InvoicePaymentError(
        503,
        "Provider verification exceeded its processing budget; uncertainty remains",
      );
  }
  if (!plan.payments.length || plan.payments.length > 16)
    throw new InvoicePaymentError(
      409,
      "Provider verification requires a bounded set of known payments",
    );
  const proofs: InvoiceProviderReconciliationProof[] = [];
  let resourceCount = 0;
  try {
    for (const payment of plan.payments) {
      withinBudget();
      const current = await getConfirmedInvoiceRefunds(
        stripe,
        payment,
        deadline,
      );
      withinBudget();
      if (
        current.paymentIntentId !== payment.paymentIntentId ||
        current.amountMinor !== payment.amountMinor ||
        current.currency !== payment.currency ||
        current.candidateIdentity.invoiceId !== plan.invoiceId ||
        current.candidateIdentity.teamId !== plan.teamId
      )
        throw new InvoicePaymentError(
          409,
          "Provider payment does not match the immutable journal",
        );
      const ids = [
        ...new Set([
          ...payment.refunds.map((row) => row.id),
          ...current.refunds.map((row) => row.id),
        ]),
      ];
      resourceCount += ids.length;
      if (resourceCount > 100)
        throw new InvoicePaymentError(
          409,
          "Provider refund history exceeds automatic verification limits",
        );
      const refunds: StripeRefundEvidence[] = [];
      for (const id of ids) {
        withinBudget();
        const exact = await stripe.refunds.retrieve(
          id,
          stripeRefundReadOptions(payment.stripeAccountId, deadline),
        );
        withinBudget();
        refunds.push(
          verifiedRefund(exact, {
            id,
            paymentIntentId: payment.paymentIntentId,
            currency: payment.currency,
            maximumMinor: payment.amountMinor,
          }),
        );
      }
      proofs.push({
        source: "resource_get",
        paymentIntentId: payment.paymentIntentId,
        stripeAccountId: payment.stripeAccountId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        refunds,
      });
    }
    return proofs;
  } catch (error) {
    if (error instanceof InvoicePaymentError) throw error;
    throw new InvoicePaymentError(
      503,
      "Current provider resources could not be verified; uncertainty remains",
    );
  }
}
