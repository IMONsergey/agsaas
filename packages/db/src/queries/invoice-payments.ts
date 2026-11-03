import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import type { DatabaseOrTransaction, TransactionClient } from "../client";
import { InvoicePaymentError } from "../errors";
import { getInvoicePaymentAmount } from "../invoice-money";
export { getInvoicePaymentAmount } from "../invoice-money";
import { invoicePaymentReservations, invoices, teams } from "../schema";
import { financialRequestHash } from "../financial-job";
import {
  getInvoiceSettlement,
  getInvoiceSettlementEntries,
  lockInvoiceSettlementOwner,
  reconcileInvoiceSettlement,
  recordInvoiceSettlement,
  requireInvoiceSettlementProviderReconciliation,
  STRIPE_LEDGER_RECONCILIATION_REASON,
} from "./invoice-settlements";
import { appendSecurityAuditEvent } from "./security-audit";

export type InvoicePaymentReservation =
  typeof invoicePaymentReservations.$inferSelect;

// Stripe v1 retains idempotency keys for at least 24 hours. Use a stricter
// 23-hour bound measured by the database clock, with a full hour of margin.
// A backwards clock or expired unknown attempt is never replayed automatically.
export const INVOICE_PAYMENT_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function canReplayInvoicePayment(
  reservation: Pick<InvoicePaymentReservation, "createdAt" | "lastAttemptAt">,
  now: string,
) {
  const created = Date.parse(reservation.createdAt);
  const previous = Date.parse(reservation.lastAttemptAt);
  const current = Date.parse(now);
  return (
    Number.isFinite(created) &&
    Number.isFinite(previous) &&
    Number.isFinite(current) &&
    previous >= created &&
    current >= previous &&
    current - created < INVOICE_PAYMENT_REPLAY_WINDOW_MS
  );
}

function isPayable(invoice: typeof invoices.$inferSelect, hasLedger = false) {
  const template = invoice.template as { paymentEnabled?: boolean } | null;
  return (
    (invoice.status === "unpaid" || invoice.status === "overdue") &&
    (hasLedger || (!invoice.paidAt && !invoice.refundedAt)) &&
    template?.paymentEnabled === true
  );
}

function matchesReservation(
  reservation: InvoicePaymentReservation,
  invoice: typeof invoices.$inferSelect,
  account: string | null,
  balanceMinor?: number,
) {
  const amount = getInvoicePaymentAmount(invoice.amount, invoice.currency);
  return (
    reservation.invoiceId === invoice.id &&
    reservation.teamId === invoice.teamId &&
    reservation.stripeAccountId === account &&
    reservation.amountMinor === (balanceMinor ?? amount.amountMinor) &&
    reservation.currency === amount.currency
  );
}

/**
 * The invoice row lock serializes reservations with draftInvoice and status
 * changes. Committing this immutable payload freezes finance before Stripe is
 * called. Metadata comes from the reservation even when invoice labels change.
 */
export async function reserveInvoicePayment(
  db: DatabaseOrTransaction,
  params: { invoiceId: string; teamId?: string },
): Promise<InvoicePaymentReservation> {
  const result = await db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, params.invoiceId),
          params.teamId ? eq(invoices.teamId, params.teamId) : undefined,
        ),
      )
      .for("update");
    if (!invoice) throw new InvoicePaymentError(404, "Invoice not found");
    const settlement = await getInvoiceSettlement(tx, {
      invoiceId: invoice.id,
      teamId: invoice.teamId,
    });
    if (
      settlement.reconciliationRequired ||
      !settlement.projection ||
      !isPayable(invoice, settlement.entries.length > 0)
    ) {
      throw new InvoicePaymentError(400, "Invoice is not payable online");
    }

    const [team] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, invoice.teamId));
    if (!team?.stripeAccountId || team.stripeConnectStatus !== "connected") {
      throw new InvoicePaymentError(400, "Payment provider is not available");
    }
    const amount = {
      ...getInvoicePaymentAmount(invoice.amount, invoice.currency),
      amountMinor: Number(settlement.projection.balanceMinor),
    };
    if (amount.amountMinor <= 0 || amount.amountMinor > 99_999_999)
      throw new InvoicePaymentError(
        400,
        "No supported outstanding amount remains",
      );
    const [existing] = await tx
      .select()
      .from(invoicePaymentReservations)
      .where(
        and(
          eq(invoicePaymentReservations.invoiceId, invoice.id),
          sql`${invoicePaymentReservations.state} <> 'settled'`,
        ),
      )
      .for("update");
    const clock = await tx.execute<{ now: string }>(
      sql`SELECT clock_timestamp()::text AS now`,
    );
    const now = clock.rows[0]!.now;

    if (existing) {
      let failureCode: string | null = null;
      if (existing.state === "reconciliation_required") {
        return { blocked: true as const };
      }
      if (
        !matchesReservation(
          existing,
          invoice,
          team.stripeAccountId,
          amount.amountMinor,
        ) ||
        (invoice.paymentIntentId !== null &&
          invoice.paymentIntentId !== existing.paymentIntentId) ||
        (existing.state === "attached" &&
          existing.paymentIntentId !== invoice.paymentIntentId)
      ) {
        failureCode = "invoice_or_account_changed";
      } else if (
        !existing.paymentIntentId &&
        !canReplayInvoicePayment(existing, now)
      ) {
        failureCode = "replay_window_expired_or_clock_changed";
      }
      if (failureCode) {
        await tx
          .update(invoicePaymentReservations)
          .set({ state: "reconciliation_required", failureCode })
          .where(eq(invoicePaymentReservations.id, existing.id));
        return { blocked: true as const };
      }
      const [reservation] = await tx
        .update(invoicePaymentReservations)
        .set({ lastAttemptAt: now })
        .where(eq(invoicePaymentReservations.id, existing.id))
        .returning();
      return { reservation: reservation! };
    }

    const priorAttempts = await tx
      .select({ id: invoicePaymentReservations.id })
      .from(invoicePaymentReservations)
      .where(eq(invoicePaymentReservations.invoiceId, invoice.id))
      .limit(1);
    // The invoice pointer denotes the current attempt; original settled IDs remain in the journal and reservations.
    if (priorAttempts.length)
      await tx
        .update(invoices)
        .set({ paymentIntentId: null })
        .where(eq(invoices.id, invoice.id));
    const legacyIntent = priorAttempts.length ? null : invoice.paymentIntentId;
    const [reservation] = await tx
      .insert(invoicePaymentReservations)
      .values({
        id: randomUUID(),
        invoiceId: invoice.id,
        teamId: invoice.teamId,
        stripeAccountId: team.stripeAccountId,
        ...amount,
        invoiceNumber: invoice.invoiceNumber ?? "",
        paymentIntentId: legacyIntent,
        state: legacyIntent ? "attached" : "reserved",
        createdAt: now,
        lastAttemptAt: now,
      })
      .returning();
    return { reservation: reservation! };
  });

  // Throw after commit so a fail-closed reconciliation marker survives.
  if ("blocked" in result) {
    throw new InvoicePaymentError(
      409,
      "Payment requires reconciliation before retrying",
    );
  }
  return result.reservation;
}

type ReservationIdentity = Pick<
  InvoicePaymentReservation,
  "id" | "invoiceId" | "teamId"
>;

export type InvoiceRefundContext = {
  invoiceId: string;
  teamId: string;
  paymentIntentId: string;
  stripeAccountId: string;
  amountMinor: number;
  currency: string;
};

export async function getInvoiceRefundContext(
  db: DatabaseOrTransaction,
  params: { invoiceId: string; teamId: string },
): Promise<InvoiceRefundContext> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, params.invoiceId),
          eq(invoices.teamId, params.teamId),
        ),
      )
      .for("update");
    if (!invoice) throw new InvoicePaymentError(404, "Invoice not found");
    if (
      !invoice.paymentIntentId ||
      !["paid", "unpaid", "overdue"].includes(invoice.status)
    )
      throw new InvoicePaymentError(
        400,
        "Invoice does not have a refundable Stripe payment",
      );
    const [reservation] = await tx
      .select()
      .from(invoicePaymentReservations)
      .where(
        and(
          eq(invoicePaymentReservations.invoiceId, invoice.id),
          eq(
            invoicePaymentReservations.paymentIntentId,
            invoice.paymentIntentId,
          ),
        ),
      )
      .for("share");
    const [team] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, params.teamId));
    const ledger = await getInvoiceSettlement(tx, params);
    if (ledger.providerReconciliationRequired)
      throw new InvoicePaymentError(
        409,
        "Verify the provider settlement before requesting another refund",
      );
    const payment = ledger.entries.find(
      (entry) =>
        entry.kind === "payment" &&
        entry.provider === "stripe" &&
        entry.providerResourceId === invoice.paymentIntentId,
    );
    const amount = getInvoicePaymentAmount(invoice.amount, invoice.currency);
    if (payment) {
      const available = ledger.projection?.paymentBalances.find(
        (row) => row.paymentId === payment.id,
      )?.refundableMinor;
      if (!available || available === "0")
        throw new InvoicePaymentError(
          400,
          "This payment has no refundable balance",
        );
    } else if (invoice.status !== "paid")
      throw new InvoicePaymentError(
        400,
        "Invoice does not have a confirmed refundable payment",
      );
    const stripeAccountId =
      reservation?.stripeAccountId ??
      payment?.providerAccountId ??
      team?.stripeAccountId;
    if (
      !stripeAccountId ||
      (reservation &&
        (reservation.state === "reconciliation_required" ||
          reservation.currency !== amount.currency ||
          reservation.amountMinor !==
            (payment ? Number(payment.amountMinor) : amount.amountMinor)))
    )
      throw new InvoicePaymentError(
        409,
        "Original payment requires reconciliation before refunding",
      );
    return {
      ...params,
      paymentIntentId: invoice.paymentIntentId,
      stripeAccountId,
      currency: amount.currency,
      amountMinor:
        reservation?.amountMinor ??
        (payment ? Number(payment.amountMinor) : amount.amountMinor),
    };
  });
}

export async function requireInvoicePaymentReconciliation(
  db: DatabaseOrTransaction,
  reservation: ReservationIdentity,
  failureCode: string,
  paymentIntentId?: string,
) {
  await db
    .update(invoicePaymentReservations)
    .set({
      state: "reconciliation_required",
      failureCode,
      ...(paymentIntentId
        ? {
            paymentIntentId: sql`COALESCE(${invoicePaymentReservations.paymentIntentId}, ${paymentIntentId})`,
          }
        : {}),
    })
    .where(
      and(
        eq(invoicePaymentReservations.id, reservation.id),
        eq(invoicePaymentReservations.invoiceId, reservation.invoiceId),
        eq(invoicePaymentReservations.teamId, reservation.teamId),
        sql`${invoicePaymentReservations.state} <> 'settled'`,
      ),
    );
}

/** Do not disclose a client secret until this current-state check commits. */
export async function attachInvoicePayment(
  db: DatabaseOrTransaction,
  params: ReservationIdentity & { paymentIntentId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, params.invoiceId),
          eq(invoices.teamId, params.teamId),
        ),
      )
      .for("update");
    if (!invoice) return false;
    const [reservation] = await tx
      .select()
      .from(invoicePaymentReservations)
      .where(
        and(
          eq(invoicePaymentReservations.id, params.id),
          eq(invoicePaymentReservations.invoiceId, params.invoiceId),
          eq(invoicePaymentReservations.teamId, params.teamId),
        ),
      )
      .for("update");
    if (!reservation || reservation.state === "settled") return false;
    const [team] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, params.teamId));

    // A verified payment/refund webhook may have won the race while this
    // caller was reading Stripe. Do not turn that established binding into a
    // reconciliation failure, and still never disclose a payable secret.
    if (
      reservation.state === "attached" &&
      (invoice.status === "paid" || invoice.status === "refunded") &&
      invoice.paymentIntentId === params.paymentIntentId &&
      reservation.paymentIntentId === params.paymentIntentId &&
      matchesReservation(reservation, invoice, reservation.stripeAccountId)
    )
      return false;

    const settlement = await getInvoiceSettlement(tx, {
      invoiceId: invoice.id,
      teamId: invoice.teamId,
    });
    let valid = false;
    try {
      valid =
        reservation.state !== "reconciliation_required" &&
        !settlement.reconciliationRequired &&
        !!settlement.projection &&
        isPayable(invoice, settlement.entries.length > 0) &&
        team?.stripeConnectStatus === "connected" &&
        matchesReservation(
          reservation,
          invoice,
          team.stripeAccountId,
          Number(settlement.projection.balanceMinor),
        ) &&
        (!invoice.paymentIntentId ||
          invoice.paymentIntentId === params.paymentIntentId) &&
        (!reservation.paymentIntentId ||
          reservation.paymentIntentId === params.paymentIntentId);
    } catch (error) {
      if (!(error instanceof InvoicePaymentError)) throw error;
    }

    await tx
      .update(invoicePaymentReservations)
      .set({
        // Retain the first known provider ID even if the invoice changed while
        // HTTP was running. Operators can reconcile without another create.
        paymentIntentId: reservation.paymentIntentId ?? params.paymentIntentId,
        state: valid ? "attached" : "reconciliation_required",
        failureCode: valid ? null : "attachment_precondition_failed",
      })
      .where(eq(invoicePaymentReservations.id, reservation.id));

    if (!valid) return false;
    await tx
      .update(invoices)
      .set({ paymentIntentId: params.paymentIntentId })
      .where(
        and(
          eq(invoices.id, params.invoiceId),
          eq(invoices.teamId, params.teamId),
        ),
      );
    return true;
  });
}

export type StripeRefundEvidence = {
  id: string;
  amountMinor: number;
  status: string;
  verifiedBy?: "resource_get";
  failureBalanceTransactionId?: string | null;
};

export type StripeInvoicePaymentEvent = {
  paymentIntentId: string;
  stripeAccountId: string;
  amountMinor: number;
  currency: string;
  kind: "paid" | "refunded";
  occurredAt: string;
  invoiceId?: string;
  teamId?: string;
  reservationId?: string;
  refunds?: StripeRefundEvidence[];
};

/** Provider signature alone is insufficient: lock and authorize the stored original account and attempt. */
export async function applyStripeInvoicePaymentEvent(
  db: DatabaseOrTransaction,
  event: StripeInvoicePaymentEvent,
) {
  if (
    !/^pi_[A-Za-z0-9]+$/.test(event.paymentIntentId) ||
    !/^acct_[A-Za-z0-9]+$/.test(event.stripeAccountId) ||
    !Number.isSafeInteger(event.amountMinor) ||
    event.amountMinor <= 0 ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    (event.kind === "refunded" && !event.refunds)
  )
    throw new InvoicePaymentError(409, "Invalid payment event binding");
  if (event.refunds) {
    const seen = new Set<string>();
    for (const refund of event.refunds) {
      if (
        !/^(re|pyr)_[A-Za-z0-9]+$/.test(refund.id) ||
        seen.has(refund.id) ||
        !Number.isSafeInteger(refund.amountMinor) ||
        refund.amountMinor <= 0 ||
        ![
          "succeeded",
          "pending",
          "requires_action",
          "failed",
          "canceled",
        ].includes(refund.status)
      )
        throw new InvoicePaymentError(409, "Invalid confirmed refund list");
      seen.add(refund.id);
    }
  }
  const result = await db.transaction(async (tx) => {
    let candidateId = event.invoiceId;
    if (!candidateId || !event.teamId) {
      const attempts = await tx
        .select({ invoiceId: invoicePaymentReservations.invoiceId })
        .from(invoicePaymentReservations)
        .where(
          and(
            eq(
              invoicePaymentReservations.paymentIntentId,
              event.paymentIntentId,
            ),
            eq(
              invoicePaymentReservations.stripeAccountId,
              event.stripeAccountId,
            ),
          ),
        )
        .limit(2);
      if (attempts.length === 1) candidateId = attempts[0]!.invoiceId;
    }
    const candidates = await tx
      .select()
      .from(invoices)
      .where(
        candidateId
          ? and(
              eq(invoices.id, candidateId),
              event.teamId ? eq(invoices.teamId, event.teamId) : undefined,
            )
          : eq(invoices.paymentIntentId, event.paymentIntentId),
      )
      .for("update");
    const invoice = candidates.length === 1 ? candidates[0] : undefined;
    if (!invoice) return { blocked: true as const };
    const [reservation] = await tx
      .select()
      .from(invoicePaymentReservations)
      .where(
        and(
          eq(invoicePaymentReservations.invoiceId, invoice.id),
          eq(invoicePaymentReservations.teamId, invoice.teamId),
          or(
            eq(
              invoicePaymentReservations.paymentIntentId,
              event.paymentIntentId,
            ),
            event.reservationId
              ? and(
                  eq(invoicePaymentReservations.id, event.reservationId),
                  sql`${invoicePaymentReservations.paymentIntentId} IS NULL`,
                )
              : undefined,
          ),
        ),
      )
      .for("update");
    const [team] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, invoice.teamId));
    const owns =
      event.stripeAccountId ===
        (reservation?.stripeAccountId ?? team?.stripeAccountId) &&
      (reservation
        ? reservation.paymentIntentId === event.paymentIntentId ||
          (!reservation.paymentIntentId &&
            reservation.id === event.reservationId)
        : invoice.paymentIntentId === event.paymentIntentId);
    if (!owns) return { blocked: true as const };
    const amount = getInvoicePaymentAmount(invoice.amount, invoice.currency);
    const boundAmount = reservation?.amountMinor ?? amount.amountMinor;
    if (
      boundAmount !== event.amountMinor ||
      amount.currency !== event.currency ||
      (reservation && reservation.currency !== event.currency) ||
      invoice.status === "canceled"
    ) {
      if (reservation)
        await tx
          .update(invoicePaymentReservations)
          .set({
            state: "reconciliation_required",
            failureCode: "webhook_binding_or_state_mismatch",
          })
          .where(eq(invoicePaymentReservations.id, reservation.id));
      return { blocked: true as const };
    }
    if (!["unpaid", "overdue", "paid", "refunded"].includes(invoice.status))
      return { blocked: true as const };
    const identity = {
      invoiceId: invoice.id,
      teamId: invoice.teamId,
      provider: "stripe" as const,
      providerAccountId: event.stripeAccountId,
      currency: event.currency,
    };
    const payment = await recordInvoiceSettlement(tx, {
      ...identity,
      operationKey: financialRequestHash(
        `stripe/${event.stripeAccountId}/${event.paymentIntentId}/payment`,
      ),
      kind: "payment",
      amountMinor: String(event.amountMinor),
      providerResourceId: event.paymentIntentId,
      occurredAt: event.occurredAt,
      reason: "Stripe confirmed payment",
    });
    let projection = payment.projection;
    if (event.refunds) {
      const history = await getInvoiceSettlementEntries(
        tx,
        invoice.teamId,
        invoice.id,
      );
      const knownRefunds = history.filter(
        (row) => row.kind === "refund" && row.paymentId === payment.entry.id,
      );
      const uncertainty = (
        await tx.execute<{ required: boolean }>(sql`
        select reconciliation_required as required from invoice_settlement_state
        where invoice_id=${invoice.id}::uuid and team_id=${invoice.teamId}::uuid`)
      ).rows[0];
      const anomalous = knownRefunds.some((row) => {
        const refund = event.refunds!.find(
          (value) => value.id === row.providerResourceId,
        );
        return (
          !refund ||
          String(refund.amountMinor) !== row.amountMinor ||
          ["pending", "requires_action"].includes(refund.status) ||
          (refund.status === "succeeded" &&
            history.some(
              (entry) =>
                entry.kind === "refund_reversal" && entry.reversesId === row.id,
            )) ||
          (["failed", "canceled"].includes(refund.status) &&
            (uncertainty?.required ||
              refund.verifiedBy !== "resource_get" ||
              !/^txn_[A-Za-z0-9]+$/.test(
                refund.failureBalanceTransactionId ?? "",
              )))
        );
      });
      if (anomalous) {
        await requireInvoiceSettlementProviderReconciliation(tx, {
          invoiceId: invoice.id,
          teamId: invoice.teamId,
        });
        // Commit the uncertainty before returning an error to the adapter.
        return { blocked: true as const };
      }
      for (const refund of event.refunds) {
        const original = knownRefunds.find(
          (row) => row.providerResourceId === refund.id,
        );
        if (refund.status === "succeeded") {
          projection = (
            await recordInvoiceSettlement(tx, {
              ...identity,
              operationKey: financialRequestHash(
                `stripe/${event.stripeAccountId}/${refund.id}/refund`,
              ),
              kind: "refund",
              amountMinor: String(refund.amountMinor),
              paymentId: payment.entry.id,
              providerResourceId: refund.id,
              occurredAt: event.occurredAt,
              reason: "Stripe confirmed refund",
            })
          ).projection;
        } else if (original && ["failed", "canceled"].includes(refund.status)) {
          projection = (
            await recordInvoiceSettlement(tx, {
              ...identity,
              operationKey: financialRequestHash(
                `stripe/${event.stripeAccountId}/${refund.id}/reversal`,
              ),
              kind: "refund_reversal",
              amountMinor: original.amountMinor,
              paymentId: payment.entry.id,
              reversesId: original.id,
              providerResourceId: refund.id,
              occurredAt: event.occurredAt,
              reason: "Stripe reversed a previously confirmed refund",
            })
          ).projection;
        }
      }
    }
    if (reservation)
      await tx
        .update(invoicePaymentReservations)
        .set({
          paymentIntentId: event.paymentIntentId,
          state: "settled",
          failureCode: null,
        })
        .where(eq(invoicePaymentReservations.id, reservation.id));
    // A historical event must not replace the current unresolved attempt's pointer.
    const [unresolved] = await tx
      .select({ id: invoicePaymentReservations.id })
      .from(invoicePaymentReservations)
      .where(
        and(
          eq(invoicePaymentReservations.invoiceId, invoice.id),
          sql`${invoicePaymentReservations.state}<>'settled'`,
        ),
      )
      .limit(1);
    if (
      (!unresolved || unresolved.id === reservation?.id) &&
      (!invoice.paymentIntentId ||
        invoice.paymentIntentId === event.paymentIntentId)
    )
      await tx
        .update(invoices)
        .set({ paymentIntentId: event.paymentIntentId })
        .where(eq(invoices.id, invoice.id));
    const [updated] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoice.id));
    return {
      invoice: updated!,
      projection,
      notify:
        event.kind === "paid"
          ? projection.status === "paid"
          : projection.status === "refunded",
    };
  });
  if ("blocked" in result)
    throw new InvoicePaymentError(409, "Payment event requires reconciliation");
  return result;
}

export type InvoiceProviderReconciliationPlan = {
  invoiceId: string;
  teamId: string;
  revision: string;
  payments: Array<{
    paymentIntentId: string;
    stripeAccountId: string;
    amountMinor: number;
    currency: string;
    refunds: Array<{ id: string; amountMinor: number; reversed: boolean }>;
  }>;
};

/** Internal adapter output: HTTP callers cannot submit these proofs. */
export type InvoiceProviderReconciliationProof = {
  source: "resource_get";
  paymentIntentId: string;
  stripeAccountId: string;
  amountMinor: number;
  currency: string;
  refunds: StripeRefundEvidence[];
};

async function loadProviderReconciliationPlan(
  tx: TransactionClient,
  input: { invoiceId: string; teamId: string },
): Promise<InvoiceProviderReconciliationPlan | null> {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.id, input.invoiceId), eq(invoices.teamId, input.teamId)),
    )
    .for("update");
  if (!invoice) throw new InvoicePaymentError(404, "Invoice not found");
  const state = (
    await tx.execute<{
      required: boolean;
      reason: string | null;
      updatedAt: string;
    }>(sql`select reconciliation_required as required,reason,updated_at::text as "updatedAt"
    from invoice_settlement_state where invoice_id=${input.invoiceId}::uuid and team_id=${input.teamId}::uuid`)
  ).rows[0];
  if (!state?.required) return null;
  // An unknown create/refund request is not proved absent by checking only known IDs.
  // Never turn an unrecognized/manual_unknown marker into the automatic path.
  if (state.reason !== STRIPE_LEDGER_RECONCILIATION_REASON)
    throw new InvoicePaymentError(
      409,
      "An unknown provider request requires manual reconciliation",
    );
  if (!["unpaid", "overdue", "paid", "refunded"].includes(invoice.status))
    throw new InvoicePaymentError(
      409,
      "Invoice state requires manual reconciliation",
    );
  const unresolved = await tx
    .select({ id: invoicePaymentReservations.id })
    .from(invoicePaymentReservations)
    .where(
      and(
        eq(invoicePaymentReservations.invoiceId, input.invoiceId),
        eq(invoicePaymentReservations.teamId, input.teamId),
        sql`${invoicePaymentReservations.state} <> 'settled'`,
      ),
    )
    .limit(1);
  if (unresolved.length)
    throw new InvoicePaymentError(
      409,
      "An unfinished provider request must be reconciled first",
    );
  const entries = await getInvoiceSettlementEntries(
    tx,
    input.teamId,
    input.invoiceId,
  );
  const stripePayments = entries.filter(
    (row) => row.provider === "stripe" && row.kind === "payment",
  );
  const stripeRefunds = entries.filter(
    (row) => row.provider === "stripe" && row.kind === "refund",
  );
  if (!stripePayments.length || !stripeRefunds.length)
    throw new InvoicePaymentError(
      409,
      "Known provider resources are insufficient to clear this uncertainty",
    );
  if (stripePayments.length > 16 || stripeRefunds.length > 100)
    throw new InvoicePaymentError(
      409,
      "Provider history exceeds automatic verification limits",
    );
  const payments = stripePayments.map((payment) => ({
    paymentIntentId: payment.providerResourceId,
    stripeAccountId: payment.providerAccountId,
    amountMinor: Number(payment.amountMinor),
    currency: payment.currency,
    refunds: stripeRefunds
      .filter((refund) => refund.paymentId === payment.id)
      .map((refund) => {
        const reversed = entries
          .filter(
            (row) =>
              row.kind === "refund_reversal" && row.reversesId === refund.id,
          )
          .reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
        if (reversed !== 0n && reversed !== BigInt(refund.amountMinor))
          throw new InvoicePaymentError(
            409,
            "Partial provider reversal requires manual reconciliation",
          );
        return {
          id: refund.providerResourceId,
          amountMinor: Number(refund.amountMinor),
          reversed: reversed > 0n,
        };
      }),
  }));
  return {
    invoiceId: input.invoiceId,
    teamId: input.teamId,
    revision: financialRequestHash({ invoice, entries, state }),
    payments,
  };
}

export async function getInvoiceProviderReconciliationPlan(
  db: DatabaseOrTransaction,
  input: { invoiceId: string; teamId: string; actorId: string },
) {
  return db.transaction(async (tx) => {
    await lockInvoiceSettlementOwner(tx, input);
    return loadProviderReconciliationPlan(tx, input);
  });
}

/** Apply fresh resource evidence after HTTP has finished; no SQL lock spans provider IO. */
export async function applyInvoiceProviderReconciliation(
  db: DatabaseOrTransaction,
  input: {
    invoiceId: string;
    teamId: string;
    actorId: string;
    revision: string;
    proofs: InvoiceProviderReconciliationProof[];
  },
) {
  return db.transaction(async (tx) => {
    await lockInvoiceSettlementOwner(tx, input);
    const plan = await loadProviderReconciliationPlan(tx, input);
    if (!plan || plan.revision !== input.revision)
      throw new InvoicePaymentError(
        409,
        "Settlement changed during provider verification; verify again",
      );
    if (input.proofs.length !== plan.payments.length)
      throw new InvoicePaymentError(
        409,
        "Incomplete provider payment verification",
      );
    const seenPayments = new Set<string>();
    const reversals: Array<{
      payment: InvoiceProviderReconciliationPlan["payments"][number];
      refundId: string;
    }> = [];
    for (const proof of input.proofs) {
      const key = `${proof.stripeAccountId}/${proof.paymentIntentId}`;
      const payment = plan.payments.find(
        (row) =>
          row.paymentIntentId === proof.paymentIntentId &&
          row.stripeAccountId === proof.stripeAccountId,
      );
      if (
        proof.source !== "resource_get" ||
        !payment ||
        seenPayments.has(key) ||
        proof.amountMinor !== payment.amountMinor ||
        proof.currency !== payment.currency ||
        proof.refunds.length > 100
      )
        throw new InvoicePaymentError(
          409,
          "Provider verification does not match the original payment",
        );
      seenPayments.add(key);
      const seenRefunds = new Set<string>();
      for (const refund of proof.refunds) {
        if (
          refund.verifiedBy !== "resource_get" ||
          !/^(re|pyr)_[A-Za-z0-9]+$/.test(refund.id) ||
          seenRefunds.has(refund.id) ||
          !Number.isSafeInteger(refund.amountMinor) ||
          refund.amountMinor <= 0 ||
          refund.amountMinor > payment.amountMinor ||
          ![
            "succeeded",
            "pending",
            "requires_action",
            "failed",
            "canceled",
          ].includes(refund.status)
        )
          throw new InvoicePaymentError(
            409,
            "Incomplete or unknown refund verification",
          );
        seenRefunds.add(refund.id);
        const known = payment.refunds.find((row) => row.id === refund.id);
        const failed = ["failed", "canceled"].includes(refund.status);
        if (!known) {
          if (!failed)
            throw new InvoicePaymentError(
              409,
              "Provider money is not yet represented by the confirmed journal",
            );
          continue;
        }
        if (
          refund.amountMinor !== known.amountMinor ||
          ["pending", "requires_action"].includes(refund.status) ||
          (known.reversed && refund.status === "succeeded")
        )
          throw new InvoicePaymentError(
            409,
            "Confirmed refund still requires reconciliation",
          );
        if (
          failed &&
          !/^txn_[A-Za-z0-9]+$/.test(refund.failureBalanceTransactionId ?? "")
        )
          throw new InvoicePaymentError(
            409,
            "Refund failure has no verified return-of-funds reference",
          );
        if (failed && !known.reversed)
          reversals.push({ payment, refundId: known.id });
      }
      if (payment.refunds.some((refund) => !seenRefunds.has(refund.id)))
        throw new InvoicePaymentError(
          409,
          "A confirmed refund was not verified by its exact resource ID",
        );
    }
    const entries = await getInvoiceSettlementEntries(
      tx,
      input.teamId,
      input.invoiceId,
    );
    for (const { payment, refundId } of reversals) {
      const originalPayment = entries.find(
        (row) =>
          row.kind === "payment" &&
          row.provider === "stripe" &&
          row.providerResourceId === payment.paymentIntentId &&
          row.providerAccountId === payment.stripeAccountId,
      )!;
      const refund = entries.find(
        (row) =>
          row.kind === "refund" &&
          row.paymentId === originalPayment.id &&
          row.providerResourceId === refundId,
      )!;
      await recordInvoiceSettlement(tx, {
        invoiceId: input.invoiceId,
        teamId: input.teamId,
        operationKey: financialRequestHash(
          `stripe/${payment.stripeAccountId}/${refundId}/reversal`,
        ),
        kind: "refund_reversal",
        amountMinor: refund.amountMinor,
        currency: payment.currency,
        paymentId: originalPayment.id,
        reversesId: refund.id,
        provider: "stripe",
        providerAccountId: payment.stripeAccountId,
        providerResourceId: refundId,
        reason: "Stripe resource GET verified a returned refund",
      });
    }
    await tx.execute(sql`update invoice_settlement_state set reconciliation_required=false,reason=null,
      updated_at=greatest(clock_timestamp(),updated_at + interval '1 microsecond')
      where invoice_id=${input.invoiceId}::uuid and team_id=${input.teamId}::uuid
        and reconciliation_required and reason=${STRIPE_LEDGER_RECONCILIATION_REASON}`);
    await reconcileInvoiceSettlement(tx, { ...input, apply: true });
    await appendSecurityAuditEvent(tx, {
      teamId: input.teamId,
      actorUserId: input.actorId,
      operation: "invoice.settlement.verify_provider",
      targetType: "invoice",
      targetId: input.invoiceId,
      metadata: {
        provider: "stripe",
        status: "verified",
        count: input.proofs.length,
      },
    });
    return { state: "verified" as const, changed: true };
  });
}
