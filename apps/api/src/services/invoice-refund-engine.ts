import { InvoicePaymentError } from "@midday/db/errors";
import {
  type InvoiceRefundRequest,
  type InvoiceRefundResource,
  type invoiceRefundRequestView,
  refundRequestPayload,
  refundResourceMatches,
  refundStatus,
} from "@midday/db/invoice-refund-request";
import type {
  InvoiceRefundDispatch,
  InvoiceRefundRequestPlan,
} from "@midday/db/queries/invoice-refund-requests";
import type Stripe from "stripe";
import {
  getConfirmedInvoiceRefunds,
  type RefundStateProvider,
  stripeRefundReadOptions,
} from "./invoice-refund-request";

type RefundResource = Pick<
  Stripe.Refund,
  "id" | "payment_intent" | "amount" | "currency" | "status" | "metadata"
>;
export type DurableRefundProvider = RefundStateProvider & {
  refunds: {
    create(
      input: Stripe.RefundCreateParams,
      options: Stripe.RequestOptions,
    ): Promise<RefundResource>;
    retrieve(
      id: string,
      options: Stripe.RequestOptions,
    ): Promise<RefundResource>;
  };
};
export type RefundRequestOperations = {
  load(): Promise<InvoiceRefundRequestPlan>;
  claim(revision: string): Promise<InvoiceRefundDispatch>;
  retain(
    revision: string,
    resource: InvoiceRefundResource,
  ): Promise<{
    request: InvoiceRefundRequest;
    applicableRevision: string | null;
  }>;
  apply(
    revision: string,
    resource: InvoiceRefundResource,
  ): Promise<ReturnType<typeof invoiceRefundRequestView>>;
  unknown(claimToken: string): Promise<void>;
  view(): Promise<ReturnType<typeof invoiceRefundRequestView>>;
};

function observation(
  refund: RefundResource,
  source: InvoiceRefundResource["source"],
): InvoiceRefundResource {
  return {
    id: refund.id,
    paymentIntentId:
      typeof refund.payment_intent === "string"
        ? refund.payment_intent
        : (refund.payment_intent?.id ?? ""),
    amountMinor: refund.amount,
    currency: refund.currency,
    status: refund.status,
    invoiceId: refund.metadata?.invoice_id,
    teamId: refund.metadata?.team_id,
    requestId: refund.metadata?.invoice_refund_request_id,
    source,
  };
}
function requirePayment(
  intent: Pick<
    Stripe.PaymentIntent,
    "id" | "status" | "amount" | "amount_received" | "currency" | "metadata"
  >,
  request: InvoiceRefundRequest,
) {
  if (
    intent.id !== request.paymentIntentId ||
    intent.status !== "succeeded" ||
    intent.amount !== request.paymentAmountMinor ||
    intent.amount_received !== request.paymentAmountMinor ||
    intent.currency !== request.currency ||
    intent.metadata?.invoice_id !== request.invoiceId ||
    intent.metadata?.team_id !== request.teamId
  )
    throw new InvoicePaymentError(
      409,
      "Original payment does not match the retained refund request",
    );
}
async function readResource(
  provider: DurableRefundProvider,
  request: InvoiceRefundRequest,
  id: string,
  deadline: number,
) {
  const resource = observation(
    await provider.refunds.retrieve(
      id,
      stripeRefundReadOptions(request.stripeAccountId, deadline),
    ),
    "resource_get",
  );
  stripeRefundReadOptions(request.stripeAccountId, deadline);
  if (
    resource.id !== id ||
    resource.paymentIntentId !== request.paymentIntentId ||
    resource.currency !== request.currency ||
    !Number.isSafeInteger(resource.amountMinor) ||
    resource.amountMinor <= 0 ||
    resource.amountMinor > request.paymentAmountMinor
  )
    throw new InvoicePaymentError(
      409,
      "Refund lookup does not establish the original provider resource",
    );
  return resource;
}

/** A positive metadata match can recover a lost create response. Absence never resolves an unknown POST. */
async function inspectProvider(
  provider: DurableRefundProvider,
  request: InvoiceRefundRequest,
) {
  const deadline = performance.now() + 15_000;
  try {
    if (request.providerRefundId) {
      const intent = await provider.paymentIntents.retrieve(
        request.paymentIntentId,
        stripeRefundReadOptions(request.stripeAccountId, deadline),
      );
      requirePayment(intent, request);
      return await readResource(
        provider,
        request,
        request.providerRefundId,
        deadline,
      );
    }
    const confirmation = await getConfirmedInvoiceRefunds(
      provider,
      request,
      deadline,
      { preserveUnknownStatuses: true },
    );
    if (
      confirmation.paymentIntentId !== request.paymentIntentId ||
      confirmation.amountMinor !== request.paymentAmountMinor ||
      confirmation.currency !== request.currency ||
      confirmation.candidateIdentity.invoiceId !== request.invoiceId ||
      confirmation.candidateIdentity.teamId !== request.teamId
    )
      throw new InvoicePaymentError(
        409,
        "Original payment does not match the retained refund request",
      );
    if (confirmation.refunds.length > 100)
      throw new InvoicePaymentError(
        409,
        "Refund history exceeds automatic recovery limits",
      );
    let found: InvoiceRefundResource | null = null,
      succeeded = 0,
      unsettled = false;
    for (const listed of confirmation.refunds) {
      const resource = await readResource(
        provider,
        request,
        listed.id,
        deadline,
      );
      if (resource.requestId === request.id) {
        if (found || !refundResourceMatches(request, resource))
          throw new InvoicePaymentError(
            409,
            "Refund request has conflicting provider evidence",
          );
        found = resource;
      }
      if (resource.status === "succeeded") succeeded += resource.amountMinor;
      else if (!["failed", "canceled"].includes(resource.status ?? ""))
        unsettled = true;
    }
    if (found) return found;
    if (
      unsettled ||
      succeeded !== request.paymentAmountMinor - request.refundAmountMinor
    )
      throw new InvoicePaymentError(
        409,
        "Provider refundable balance is not the retained confirmed amount",
      );
    return null;
  } catch (error) {
    if (error instanceof InvoicePaymentError) throw error;
    throw new InvoicePaymentError(
      503,
      "The existing refund could not be verified; its request remains retained",
    );
  }
}

/** No database transaction spans these provider reads or the one bounded POST. */
export async function runInvoiceRefundRequest(
  provider: DurableRefundProvider,
  operations: RefundRequestOperations,
) {
  for (let turn = 0; turn < 2; turn++) {
    const current = await operations.load();
    const proof = await inspectProvider(provider, current.request);
    if (proof) {
      const retained = await operations.retain(current.revision, proof);
      if (!retained.applicableRevision)
        throw new InvoicePaymentError(
          409,
          "Refund changed during verification; the discovered resource was retained, resume again",
        );
      return operations.apply(retained.applicableRevision, proof);
    }
    const claimStarted = performance.now();
    const claim = await operations.claim(current.revision);
    if (claim.kind === "known") continue;
    if (claim.kind === "busy")
      throw new InvoicePaymentError(
        409,
        "This refund request is already being checked; resume the same request shortly",
      );
    if (claim.kind === "blocked")
      throw new InvoicePaymentError(
        409,
        "Unknown refund outcome requires provider reconciliation; no further create was sent",
      );
    const remainingMs =
      claim.remainingMs - Math.max(0, performance.now() - claimStarted);
    if (remainingMs < 1) {
      await operations.unknown(claim.claimToken).catch(() => {});
      throw new InvoicePaymentError(
        409,
        "Refund retry window expired before dispatch; no create was sent",
      );
    }
    let resource: InvoiceRefundResource;
    try {
      const refund = await provider.refunds.create(
        refundRequestPayload(claim.request),
        {
          stripeAccount: claim.request.stripeAccountId,
          idempotencyKey: claim.request.idempotencyKey,
          timeout: Math.max(1, Math.min(5_000, Math.floor(remainingMs))),
        },
      );
      resource = observation(refund, "create_response");
    } catch {
      // A timeout, 4xx or cached 5xx response is not proof that a previous POST had no effect.
      await operations.unknown(claim.claimToken).catch(() => {});
      throw new InvoicePaymentError(
        503,
        "Refund outcome is unknown. Resume the retained request instead of starting another refund",
      );
    }
    let retained: Awaited<ReturnType<RefundRequestOperations["retain"]>>;
    try {
      retained = await operations.retain(claim.revision, resource);
    } catch {
      await operations.unknown(claim.claimToken).catch(() => {});
      throw new InvoicePaymentError(
        503,
        "Refund response could not be retained. Check the original request before any retry",
      );
    }
    if (!retained.request.bindingVerified || !refundStatus(resource.status))
      throw new InvoicePaymentError(
        409,
        "The retained refund response requires provider reconciliation",
      );
    // This current-owner read follows receipt persistence. It does not treat a POST acknowledgment as money.
    return operations.view();
  }
  throw new InvoicePaymentError(
    409,
    "Refund state changed during recovery; resume the retained request again",
  );
}
