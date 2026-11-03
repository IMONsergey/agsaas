export const REFUND_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const refundProviderStatuses = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type RefundProviderStatus = (typeof refundProviderStatuses)[number];
export type InvoiceRefundRequestState =
  | "reserved"
  | "unknown"
  | "bound"
  | "settled"
  | "failed"
  | "manual_unknown";

export type InvoiceRefundRequest = {
  id: string;
  teamId: string;
  invoiceId: string;
  paymentEntryId: string;
  operationId: string;
  stripeAccountId: string;
  paymentIntentId: string;
  paymentAmountMinor: number;
  refundAmountMinor: number;
  currency: string;
  requestHash: string;
  idempotencyKey: string;
  actorId: string | null;
  state: InvoiceRefundRequestState;
  providerRefundId: string | null;
  providerStatus: RefundProviderStatus | null;
  bindingVerified: boolean;
  createdAt: string;
  updatedAt: string;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  attemptCount: number;
  claimToken: string | null;
  claimExpiresAt: string | null;
  failureCode: string | null;
};

export type InvoiceRefundResource = {
  id: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  status: string | null;
  invoiceId: string | undefined;
  teamId: string | undefined;
  requestId: string | undefined;
  source: "create_response" | "resource_get";
};

export function refundRequestPayload(request: InvoiceRefundRequest) {
  return {
    payment_intent: request.paymentIntentId,
    amount: request.refundAmountMinor,
    metadata: {
      invoice_id: request.invoiceId,
      team_id: request.teamId,
      invoice_refund_request_id: request.id,
    },
  };
}

export function refundReplayRemaining(
  request: InvoiceRefundRequest,
  databaseNow: string,
): number {
  if (
    request.providerRefundId ||
    !["reserved", "unknown"].includes(request.state)
  )
    return 0;
  const created = Date.parse(request.createdAt);
  const last = Date.parse(request.lastAttemptAt ?? request.createdAt);
  const now = Date.parse(databaseNow);
  if (
    ![created, last, now].every(Number.isFinite) ||
    last < created ||
    now < last
  )
    return 0;
  return Math.max(0, REFUND_REPLAY_WINDOW_MS - (now - created));
}

export function refundResourceMatches(
  request: InvoiceRefundRequest,
  resource: InvoiceRefundResource,
): boolean {
  return (
    /^(re|pyr)_[A-Za-z0-9]+$/.test(resource.id) &&
    resource.paymentIntentId === request.paymentIntentId &&
    resource.currency === request.currency &&
    Number.isSafeInteger(resource.amountMinor) &&
    resource.amountMinor === request.refundAmountMinor &&
    resource.invoiceId === request.invoiceId &&
    resource.teamId === request.teamId &&
    resource.requestId === request.id
  );
}

export function refundStatus(
  value: string | null,
): RefundProviderStatus | null {
  return refundProviderStatuses.find((status) => status === value) ?? null;
}

export function invoiceRefundRequestView(request: InvoiceRefundRequest) {
  return {
    requestId: request.id,
    state: request.state,
    refundStatus: request.providerStatus,
    amountMinor: String(request.refundAmountMinor),
    currency: request.currency,
    createdAt: request.createdAt,
    knownResource: request.providerRefundId !== null,
    accepted:
      request.bindingVerified &&
      ["pending", "requires_action", "succeeded"].includes(
        request.providerStatus ?? "",
      ),
    status:
      request.state === "settled"
        ? ("confirmed" as const)
        : request.state === "failed"
          ? ("failed" as const)
          : ["unknown", "manual_unknown"].includes(request.state)
            ? ("reconciliation_required" as const)
            : ("requested" as const),
  };
}
