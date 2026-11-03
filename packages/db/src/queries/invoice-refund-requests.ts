import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseOrTransaction, TransactionClient } from "../client";
import { InvoicePaymentError } from "../errors";
import { financialRequestHash } from "../financial-job";
import {
  type InvoiceRefundRequest,
  type InvoiceRefundResource,
  invoiceRefundRequestView,
  refundReplayRemaining,
  refundRequestPayload,
  refundResourceMatches,
  refundStatus,
} from "../invoice-refund-request";
import { invoices } from "../schema";
import { getUnresolvedInvoiceRefundRequest } from "./invoice-provider-requests";
import {
  getInvoiceSettlement,
  getInvoiceSettlementEntries,
  lockInvoiceSettlementOwner,
  recordInvoiceSettlement,
  requireInvoiceSettlementProviderReconciliation,
} from "./invoice-settlements";
import { appendSecurityAuditEvent } from "./security-audit";

type Actor = { invoiceId: string; teamId: string; actorId: string };
const columns = sql`id,team_id AS "teamId",invoice_id AS "invoiceId",payment_entry_id AS "paymentEntryId",operation_id AS "operationId",
  stripe_account_id AS "stripeAccountId",payment_intent_id AS "paymentIntentId",payment_amount_minor::int AS "paymentAmountMinor",
  refund_amount_minor::int AS "refundAmountMinor",currency,request_hash AS "requestHash",idempotency_key AS "idempotencyKey",actor_id AS "actorId",
  state,provider_refund_id AS "providerRefundId",provider_status AS "providerStatus",binding_verified AS "bindingVerified",
  created_at::text AS "createdAt",updated_at::text AS "updatedAt",first_attempt_at::text AS "firstAttemptAt",last_attempt_at::text AS "lastAttemptAt",
  attempt_count AS "attemptCount",claim_token AS "claimToken",claim_expires_at::text AS "claimExpiresAt",failure_code AS "failureCode"`;

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}
async function invoiceForUpdate(
  tx: TransactionClient,
  scope: { invoiceId: string; teamId: string },
) {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.id, scope.invoiceId), eq(invoices.teamId, scope.teamId)),
    )
    .for("update");
  if (!invoice) throw new InvoicePaymentError(404, "Invoice not found");
  return invoice;
}
async function requestForUpdate(
  tx: TransactionClient,
  scope: { invoiceId: string; teamId: string; requestId: string },
) {
  const result =
    await tx.execute<InvoiceRefundRequest>(sql`SELECT ${columns} FROM public.invoice_refund_requests
    WHERE id=${scope.requestId}::uuid AND invoice_id=${scope.invoiceId}::uuid AND team_id=${scope.teamId}::uuid FOR UPDATE`);
  if (!result.rows[0])
    throw new InvoicePaymentError(404, "Refund request not found");
  return result.rows[0];
}
async function clock(tx: TransactionClient) {
  return (
    await tx.execute<{ now: string }>(
      sql`SELECT clock_timestamp()::text AS now`,
    )
  ).rows[0]!.now;
}
async function revision(tx: TransactionClient, request: InvoiceRefundRequest) {
  const invoice = await invoiceForUpdate(tx, request);
  const entries = await getInvoiceSettlementEntries(
    tx,
    request.teamId,
    request.invoiceId,
  );
  const marker =
    (
      await tx.execute<{
        value: unknown;
      }>(sql`SELECT to_jsonb(s) AS value FROM public.invoice_settlement_state s
    WHERE invoice_id=${request.invoiceId}::uuid AND team_id=${request.teamId}::uuid`)
    ).rows[0]?.value ?? null;
  return financialRequestHash({ invoice, entries, marker, request });
}
export type InvoiceRefundRequestPlan = {
  request: InvoiceRefundRequest;
  revision: string;
  databaseNow: string;
  replayRemainingMs: number;
};
async function plan(
  tx: TransactionClient,
  request: InvoiceRefundRequest,
): Promise<InvoiceRefundRequestPlan> {
  const databaseNow = await clock(tx);
  return {
    request,
    revision: await revision(tx, request),
    databaseNow,
    replayRemainingMs: refundReplayRemaining(request, databaseNow),
  };
}

/** Current owner -> invoice -> immutable request. No network operation belongs in this transaction. */
export async function prepareInvoiceRefundRequest(
  db: DatabaseOrTransaction,
  input: Actor & { operationId: string },
): Promise<InvoiceRefundRequestPlan> {
  return primary(db).transaction(async (tx) => {
    await lockInvoiceSettlementOwner(tx, input);
    const invoice = await invoiceForUpdate(tx, input);
    const existing = (
      await tx.execute<InvoiceRefundRequest>(sql`SELECT ${columns} FROM public.invoice_refund_requests
      WHERE team_id=${input.teamId}::uuid AND operation_id=${input.operationId}::uuid FOR UPDATE`)
    ).rows[0];
    if (existing) {
      if (existing.invoiceId !== input.invoiceId)
        throw new InvoicePaymentError(
          409,
          "Refund operation identity was already used for another invoice",
        );
      return plan(tx, existing);
    }
    if (await getUnresolvedInvoiceRefundRequest(tx, input))
      throw new InvoicePaymentError(
        409,
        "Resolve the existing refund request before starting another",
      );
    const unresolvedPayment =
      await tx.execute(sql`SELECT 1 FROM public.invoice_payment_reservations
      WHERE invoice_id=${input.invoiceId}::uuid AND team_id=${input.teamId}::uuid AND state<>'settled' LIMIT 1`);
    if (unresolvedPayment.rows.length)
      throw new InvoicePaymentError(
        409,
        "Resolve the existing provider payment before refunding",
      );
    const settlement = await getInvoiceSettlement(tx, input);
    if (settlement.reconciliationRequired || !settlement.projection)
      throw new InvoicePaymentError(
        409,
        "Verify the original settlement before requesting a refund",
      );
    if (!["paid", "unpaid", "overdue"].includes(invoice.status))
      throw new InvoicePaymentError(
        400,
        "Invoice does not have a refundable payment",
      );
    const payment = settlement.entries.find(
      (entry) =>
        entry.kind === "payment" &&
        entry.provider === "stripe" &&
        entry.providerResourceId === invoice.paymentIntentId,
    );
    const available = settlement.projection.paymentBalances.find(
      (entry) => entry.paymentId === payment?.id,
    )?.refundableMinor;
    const amount = Number(available ?? "0");
    if (
      !payment ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      Number(payment.amountMinor) > 99_999_999
    )
      throw new InvoicePaymentError(
        409,
        "A confirmed original payment and exact refundable balance are required",
      );
    const id = randomUUID();
    const payload = {
      payment_intent: payment.providerResourceId,
      amount,
      metadata: {
        invoice_id: input.invoiceId,
        team_id: input.teamId,
        invoice_refund_request_id: id,
      },
    };
    const inserted =
      await tx.execute<InvoiceRefundRequest>(sql`INSERT INTO public.invoice_refund_requests
      (id,team_id,invoice_id,payment_entry_id,operation_id,stripe_account_id,payment_intent_id,payment_amount_minor,refund_amount_minor,currency,request_hash,idempotency_key,actor_id)
      VALUES (${id}::uuid,${input.teamId}::uuid,${input.invoiceId}::uuid,${payment.id}::uuid,${input.operationId}::uuid,
        ${payment.providerAccountId},${payment.providerResourceId},${payment.amountMinor}::bigint,${amount},${payment.currency},
        ${financialRequestHash(payload)},${`invoice-refund/${id}/v2`},${input.actorId}::uuid) RETURNING ${columns}`);
    await appendSecurityAuditEvent(tx, {
      teamId: input.teamId,
      actorUserId: input.actorId,
      operation: "invoice.refund.prepare",
      targetType: "invoice",
      targetId: input.invoiceId,
      metadata: { provider: "stripe", status: "reserved" },
    });
    return plan(tx, inserted.rows[0]!);
  });
}

export async function getInvoiceRefundRequestPlan(
  db: DatabaseOrTransaction,
  input: Actor & { requestId: string },
): Promise<InvoiceRefundRequestPlan> {
  return primary(db).transaction(async (tx) => {
    await lockInvoiceSettlementOwner(tx, input);
    await invoiceForUpdate(tx, input);
    return plan(tx, await requestForUpdate(tx, input));
  });
}

export type InvoiceRefundDispatch =
  | {
      kind: "dispatch";
      request: InvoiceRefundRequest;
      revision: string;
      remainingMs: number;
      claimToken: string;
    }
  | { kind: "known" | "busy" | "blocked"; request: InvoiceRefundRequest };

/** The last authorization point before POST; retries never change key, payload or creation age. */
export async function claimInvoiceRefundDispatch(
  db: DatabaseOrTransaction,
  input: Actor & { requestId: string; revision: string },
): Promise<InvoiceRefundDispatch> {
  return primary(db).transaction(async (tx): Promise<InvoiceRefundDispatch> => {
    await lockInvoiceSettlementOwner(tx, input);
    await invoiceForUpdate(tx, input);
    let request = await requestForUpdate(tx, input);
    if (request.providerRefundId) return { kind: "known", request };
    if (!["reserved", "unknown"].includes(request.state))
      return { kind: "blocked", request };
    if ((await revision(tx, request)) !== input.revision)
      throw new InvoicePaymentError(
        409,
        "Refund state changed during provider verification; resume again",
      );
    if (
      request.requestHash !==
      financialRequestHash(refundRequestPayload(request))
    )
      throw new InvoicePaymentError(
        409,
        "Refund request identity is inconsistent",
      );
    const now = await clock(tx),
      remainingMs = refundReplayRemaining(request, now);
    if (remainingMs < 1) {
      if (!["settled", "failed"].includes(request.state))
        request = (
          await tx.execute<InvoiceRefundRequest>(sql`UPDATE public.invoice_refund_requests SET
        state='manual_unknown',failure_code='replay_window_expired',claim_token=NULL,claim_expires_at=NULL,
        updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${request.id}::uuid RETURNING ${columns}`)
        ).rows[0]!;
      return { kind: "blocked", request };
    }
    if (
      request.claimExpiresAt &&
      Date.parse(request.claimExpiresAt) > Date.parse(now)
    )
      return { kind: "busy", request };
    const blocked =
      await tx.execute(sql`SELECT 1 FROM public.invoice_settlement_state WHERE invoice_id=${input.invoiceId}::uuid AND reconciliation_required
      UNION ALL SELECT 1 FROM public.invoice_payment_reservations WHERE invoice_id=${input.invoiceId}::uuid AND state<>'settled' LIMIT 1`);
    if (blocked.rows.length)
      throw new InvoicePaymentError(
        409,
        "Another provider operation or settlement uncertainty must be resolved first",
      );
    const claimToken = randomUUID();
    request = (
      await tx.execute<InvoiceRefundRequest>(sql`UPDATE public.invoice_refund_requests SET state='unknown',
      first_attempt_at=coalesce(first_attempt_at,${now}::timestamptz),last_attempt_at=${now}::timestamptz,attempt_count=attempt_count+1,
      claim_token=${claimToken}::uuid,claim_expires_at=${now}::timestamptz+interval '30 seconds',failure_code=NULL,
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${request.id}::uuid RETURNING ${columns}`)
    ).rows[0]!;
    await appendSecurityAuditEvent(tx, {
      teamId: input.teamId,
      actorUserId: input.actorId,
      operation: "invoice.refund.dispatch",
      targetType: "invoice",
      targetId: input.invoiceId,
      metadata: {
        provider: "stripe",
        status: "unknown",
        count: request.attemptCount,
      },
    });
    return {
      kind: "dispatch",
      request,
      claimToken,
      remainingMs,
      revision: await revision(tx, request),
    };
  });
}

export async function markInvoiceRefundDispatchUnknown(
  db: DatabaseOrTransaction,
  input: {
    invoiceId: string;
    teamId: string;
    requestId: string;
    claimToken: string;
  },
) {
  return primary(db).transaction(async (tx) => {
    await invoiceForUpdate(tx, input);
    const request = await requestForUpdate(tx, input);
    if (
      request.claimToken !== input.claimToken ||
      request.providerRefundId ||
      request.state !== "unknown"
    )
      return;
    await tx.execute(sql`UPDATE public.invoice_refund_requests SET failure_code='provider_outcome_unknown',
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${request.id}::uuid`);
  });
}

/** Retaining an irreversible receipt is allowed after actor revocation; it never writes money or clears a marker. */
export async function retainInvoiceRefundResource(
  db: DatabaseOrTransaction,
  input: {
    invoiceId: string;
    teamId: string;
    requestId: string;
    revision: string;
    resource: InvoiceRefundResource;
  },
) {
  return primary(db).transaction(async (tx) => {
    await invoiceForUpdate(tx, input);
    let request = await requestForUpdate(tx, input);
    const unchanged = (await revision(tx, request)) === input.revision;
    const idValid = /^(re|pyr)_[A-Za-z0-9]+$/.test(input.resource.id);
    const conflict =
      request.providerRefundId !== null &&
      request.providerRefundId !== input.resource.id;
    const matches = refundResourceMatches(request, input.resource) && !conflict;
    if (conflict)
      await requireInvoiceSettlementProviderReconciliation(tx, {
        ...input,
        manualUnknown: true,
      });
    const terminal = ["settled", "failed"].includes(request.state);
    const status = refundStatus(input.resource.status);
    request = (
      await tx.execute<InvoiceRefundRequest>(sql`UPDATE public.invoice_refund_requests SET
      provider_refund_id=coalesce(provider_refund_id,${idValid ? input.resource.id : null}),
      binding_verified=binding_verified OR ${matches},
      provider_status=CASE WHEN ${terminal} THEN provider_status ELSE ${status} END,
      state=CASE WHEN ${terminal} THEN state WHEN ${matches && status !== null} THEN 'bound' ELSE 'manual_unknown' END,
      failure_code=${matches ? null : "provider_binding_mismatch"},claim_token=NULL,claim_expires_at=NULL,
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${request.id}::uuid RETURNING ${columns}`)
    ).rows[0]!;
    return {
      request,
      applicableRevision:
        unchanged && matches ? await revision(tx, request) : null,
    };
  });
}

/** Exact GET evidence may finish this request, but never removes an unrelated settlement fence. */
export async function applyInvoiceRefundResource(
  db: DatabaseOrTransaction,
  input: Actor & {
    requestId: string;
    revision: string;
    resource: InvoiceRefundResource;
  },
) {
  return primary(db).transaction(async (tx) => {
    await lockInvoiceSettlementOwner(tx, input);
    await invoiceForUpdate(tx, input);
    let request = await requestForUpdate(tx, input);
    if ((await revision(tx, request)) !== input.revision)
      throw new InvoicePaymentError(
        409,
        "Refund state changed during provider verification; resume again",
      );
    if (
      input.resource.source !== "resource_get" ||
      !request.bindingVerified ||
      request.providerRefundId !== input.resource.id ||
      !refundResourceMatches(request, input.resource)
    )
      throw new InvoicePaymentError(
        409,
        "An exact original refund resource is required",
      );
    const entries = await getInvoiceSettlementEntries(
      tx,
      input.teamId,
      input.invoiceId,
    );
    const original = entries.find(
      (entry) =>
        entry.kind === "refund" &&
        entry.paymentId === request.paymentEntryId &&
        entry.providerResourceId === request.providerRefundId,
    );
    const reversed =
      original &&
      entries.some(
        (entry) =>
          entry.kind === "refund_reversal" && entry.reversesId === original.id,
      );
    const status = refundStatus(input.resource.status);
    const terminal = ["settled", "failed"].includes(request.state);
    if (
      (terminal && status !== request.providerStatus) ||
      (reversed && status === "succeeded")
    ) {
      await requireInvoiceSettlementProviderReconciliation(tx, {
        ...input,
        manualUnknown: !original,
      });
      return {
        ...invoiceRefundRequestView(request),
        status: "reconciliation_required" as const,
      };
    }
    if (original && status !== "succeeded" && !reversed)
      await requireInvoiceSettlementProviderReconciliation(tx, input);
    if (status === "succeeded")
      await recordInvoiceSettlement(tx, {
        invoiceId: input.invoiceId,
        teamId: input.teamId,
        operationKey: financialRequestHash(
          `stripe/${request.stripeAccountId}/${input.resource.id}/refund`,
        ),
        kind: "refund",
        amountMinor: String(request.refundAmountMinor),
        currency: request.currency,
        paymentId: request.paymentEntryId,
        provider: "stripe",
        providerAccountId: request.stripeAccountId,
        providerResourceId: input.resource.id,
        reason: "Stripe resource GET confirmed the original refund request",
      });
    const next =
      status === "succeeded"
        ? "settled"
        : status === "failed" || status === "canceled"
          ? "failed"
          : status
            ? "bound"
            : "manual_unknown";
    if (!terminal)
      request = (
        await tx.execute<InvoiceRefundRequest>(sql`UPDATE public.invoice_refund_requests SET state=${next},provider_status=${status},
      claim_token=NULL,claim_expires_at=NULL,failure_code=${status ? null : "unknown_provider_status"},
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${request.id}::uuid RETURNING ${columns}`)
      ).rows[0]!;
    await appendSecurityAuditEvent(tx, {
      teamId: input.teamId,
      actorUserId: input.actorId,
      operation: "invoice.refund.reconcile",
      targetType: "invoice",
      targetId: input.invoiceId,
      metadata: { provider: "stripe", status: request.state },
    });
    return invoiceRefundRequestView(request);
  });
}

/** The webhook has already authorized the original account/payment and recorded its confirmed journal facts. */
export async function settleKnownInvoiceRefundRequests(
  tx: TransactionClient,
  input: {
    invoiceId: string;
    teamId: string;
    stripeAccountId: string;
    paymentIntentId: string;
    refunds: Array<{
      id: string;
      amountMinor: number;
      status: string;
      verifiedBy?: "resource_get";
    }>;
  },
) {
  const rows = (
    await tx.execute<InvoiceRefundRequest>(sql`SELECT ${columns} FROM public.invoice_refund_requests
    WHERE invoice_id=${input.invoiceId}::uuid AND team_id=${input.teamId}::uuid AND stripe_account_id=${input.stripeAccountId}
      AND payment_intent_id=${input.paymentIntentId} AND binding_verified FOR UPDATE`)
  ).rows;
  const entries = await getInvoiceSettlementEntries(
    tx,
    input.teamId,
    input.invoiceId,
  );
  for (const request of rows) {
    const evidence = input.refunds.find(
      (refund) =>
        refund.id === request.providerRefundId &&
        refund.amountMinor === request.refundAmountMinor,
    );
    const journaled = entries.some(
      (entry) =>
        entry.kind === "refund" &&
        entry.paymentId === request.paymentEntryId &&
        entry.providerResourceId === request.providerRefundId &&
        Number(entry.amountMinor) === request.refundAmountMinor,
    );
    if (["settled", "failed"].includes(request.state)) {
      if (!evidence || refundStatus(evidence.status) !== request.providerStatus)
        await requireInvoiceSettlementProviderReconciliation(tx, {
          invoiceId: input.invoiceId,
          teamId: input.teamId,
          manualUnknown: !journaled,
        });
      continue;
    }
    if (!evidence) continue;
    const status = refundStatus(evidence.status);
    const next =
      status === "succeeded" && journaled
        ? "settled"
        : ["failed", "canceled"].includes(status ?? "") &&
            evidence.verifiedBy === "resource_get"
          ? "failed"
          : null;
    if (!next) continue;
    if (request.state !== "bound")
      await tx.execute(sql`UPDATE public.invoice_refund_requests SET state='bound',provider_status=${status},
      claim_token=NULL,claim_expires_at=NULL,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${request.id}::uuid`);
    await tx.execute(sql`UPDATE public.invoice_refund_requests SET state=${next},provider_status=${status},claim_token=NULL,claim_expires_at=NULL,failure_code=NULL,
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${request.id}::uuid`);
  }
}
