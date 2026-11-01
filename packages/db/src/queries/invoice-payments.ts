import { randomUUID } from "node:crypto";
import { getCurrencyMultiplier } from "@midday/invoice/currency";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { InvoicePaymentError } from "../errors";
import { invoicePaymentReservations, invoices, teams } from "../schema";

export type InvoicePaymentReservation =
  typeof invoicePaymentReservations.$inferSelect;

// Stripe v1 retains idempotency keys for at least 24 hours. Use a stricter
// 23-hour bound measured by the database clock, with a full hour of margin.
// A backwards clock or expired unknown attempt is never replayed automatically.
export const INVOICE_PAYMENT_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function getInvoicePaymentAmount(
  amount: number | null,
  currency: string | null,
) {
  if (
    !currency ||
    !/^[a-z]{3}$/i.test(currency) ||
    amount === null ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 99_999_999.99
  ) {
    throw new InvoicePaymentError(
      400,
      "Invalid invoice payment amount or currency",
    );
  }

  // Storage is numeric(10,2). Reject fractional minor units instead of silently
  // rounding e.g. JPY 100.25 down to a different charge amount.
  const fixed = amount.toFixed(2);
  if (Number(fixed) !== amount) {
    throw new InvoicePaymentError(
      400,
      "Invoice amount exceeds storage precision",
    );
  }
  const [whole, fraction] = fixed.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction!);
  const normalized = currency.toLowerCase();
  // Stripe's charge API retains two-decimal wire units for ISK and UGX even
  // though neither currency permits fractional charges. Keep the whole-unit
  // validation separate from the shared Stripe wire/display conversion.
  const legacyTwoDecimalWire = normalized === "isk" || normalized === "ugx";
  if (legacyTwoDecimalWire && cents % 100n !== 0n) {
    throw new InvoicePaymentError(
      400,
      "This currency requires a whole-unit charge",
    );
  }
  const scaled = cents * BigInt(getCurrencyMultiplier(currency));
  if (scaled % 100n !== 0n || scaled / 100n > 99_999_999n) {
    throw new InvoicePaymentError(
      400,
      "Invoice amount is not supported for this currency",
    );
  }
  return { amountMinor: Number(scaled / 100n), currency: normalized };
}

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

function isPayable(invoice: typeof invoices.$inferSelect) {
  const template = invoice.template as { paymentEnabled?: boolean } | null;
  return (
    (invoice.status === "unpaid" || invoice.status === "overdue") &&
    !invoice.paidAt &&
    !invoice.refundedAt &&
    template?.paymentEnabled === true
  );
}

function matchesReservation(
  reservation: InvoicePaymentReservation,
  invoice: typeof invoices.$inferSelect,
  account: string | null,
) {
  const amount = getInvoicePaymentAmount(invoice.amount, invoice.currency);
  return (
    reservation.invoiceId === invoice.id &&
    reservation.teamId === invoice.teamId &&
    reservation.stripeAccountId === account &&
    reservation.amountMinor === amount.amountMinor &&
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
    if (!isPayable(invoice)) {
      throw new InvoicePaymentError(400, "Invoice is not payable online");
    }

    const [team] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, invoice.teamId));
    if (!team?.stripeAccountId || team.stripeConnectStatus !== "connected") {
      throw new InvoicePaymentError(400, "Payment provider is not available");
    }
    const amount = getInvoicePaymentAmount(invoice.amount, invoice.currency);
    const [existing] = await tx
      .select()
      .from(invoicePaymentReservations)
      .where(eq(invoicePaymentReservations.invoiceId, invoice.id))
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
        !matchesReservation(existing, invoice, team.stripeAccountId) ||
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

    const [reservation] = await tx
      .insert(invoicePaymentReservations)
      .values({
        id: randomUUID(),
        invoiceId: invoice.id,
        teamId: invoice.teamId,
        stripeAccountId: team.stripeAccountId,
        ...amount,
        invoiceNumber: invoice.invoiceNumber ?? "",
        paymentIntentId: invoice.paymentIntentId,
        state: invoice.paymentIntentId ? "attached" : "reserved",
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
      .for("share");
    if (!invoice) throw new InvoicePaymentError(404, "Invoice not found");
    if (invoice.status !== "paid" || !invoice.paymentIntentId) {
      throw new InvoicePaymentError(
        400,
        "Invoice does not have a refundable Stripe payment",
      );
    }
    const [reservation] = await tx
      .select()
      .from(invoicePaymentReservations)
      .where(eq(invoicePaymentReservations.invoiceId, invoice.id))
      .for("share");
    const [team] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, params.teamId));
    const amount = getInvoicePaymentAmount(invoice.amount, invoice.currency);
    // Historical reservations retain their original connected account even
    // after the company disconnects or connects another account. A legacy
    // payment without a reservation must be verified with Stripe before refund.
    const stripeAccountId =
      reservation?.stripeAccountId ?? team?.stripeAccountId;
    if (
      !stripeAccountId ||
      (reservation &&
        (reservation.state === "reconciliation_required" ||
          reservation.paymentIntentId !== invoice.paymentIntentId ||
          reservation.amountMinor !== amount.amountMinor ||
          reservation.currency !== amount.currency))
    )
      throw new InvoicePaymentError(
        409,
        "Original payment requires reconciliation before refunding",
      );
    return {
      ...params,
      paymentIntentId: invoice.paymentIntentId,
      stripeAccountId,
      ...amount,
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
    if (!reservation) return false;
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

    let valid = false;
    try {
      valid =
        reservation.state !== "reconciliation_required" &&
        isPayable(invoice) &&
        team?.stripeConnectStatus === "connected" &&
        matchesReservation(reservation, invoice, team.stripeAccountId) &&
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
};

/**
 * A valid Stripe signature is not invoice authorization: metadata is editable
 * at the connected account. Bind the event to the stored intent/reservation,
 * original account and exact financial snapshot before applying a transition.
 */
export async function applyStripeInvoicePaymentEvent(
  db: DatabaseOrTransaction,
  event: StripeInvoicePaymentEvent,
) {
  if (
    !/^pi_[A-Za-z0-9]+$/.test(event.paymentIntentId) ||
    !/^acct_[A-Za-z0-9]+$/.test(event.stripeAccountId) ||
    !Number.isSafeInteger(event.amountMinor) ||
    event.amountMinor <= 0 ||
    !Number.isFinite(Date.parse(event.occurredAt))
  )
    throw new InvoicePaymentError(409, "Invalid payment event binding");

  const result = await db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(invoices)
      .where(
        event.invoiceId && event.teamId
          ? and(
              eq(invoices.id, event.invoiceId),
              eq(invoices.teamId, event.teamId),
            )
          : eq(invoices.paymentIntentId, event.paymentIntentId),
      )
      .for("update");
    const invoice = candidates.length === 1 ? candidates[0] : undefined;
    if (!invoice) return { blocked: true as const };
    const [reservation] = await tx
      .select()
      .from(invoicePaymentReservations)
      .where(eq(invoicePaymentReservations.invoiceId, invoice.id))
      .for("update");
    const [team] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, invoice.teamId));
    const ownsStoredPayment =
      event.stripeAccountId ===
        (reservation?.stripeAccountId ?? team?.stripeAccountId) &&
      (!invoice.paymentIntentId ||
        invoice.paymentIntentId === event.paymentIntentId) &&
      (reservation
        ? reservation.paymentIntentId === event.paymentIntentId ||
          (!reservation.paymentIntentId &&
            event.reservationId === reservation.id)
        : invoice.paymentIntentId === event.paymentIntentId);
    // Editable metadata must not be allowed even to block another team's
    // reservation. Establish provider ownership before any reconciliation write.
    if (!ownsStoredPayment) return { blocked: true as const };
    const snapshot = getInvoicePaymentAmount(invoice.amount, invoice.currency);
    const financialMatches =
      snapshot.amountMinor === event.amountMinor &&
      snapshot.currency === event.currency &&
      (!reservation ||
        (reservation.amountMinor === event.amountMinor &&
          reservation.currency === event.currency));
    if (!financialMatches || invoice.status === "canceled") {
      if (reservation) {
        await tx
          .update(invoicePaymentReservations)
          .set({
            state: "reconciliation_required",
            failureCode: "webhook_binding_or_state_mismatch",
          })
          .where(eq(invoicePaymentReservations.id, reservation.id));
      }
      return { blocked: true as const };
    }
    // A late succeeded event must never roll a full refund backwards.
    if (invoice.status === "refunded" && event.kind === "paid") {
      return { invoice, notify: false };
    }
    if (invoice.status === event.kind) {
      // Retry notification enqueue after a previous DB commit / Redis failure.
      // The webhook caller uses a stable provider-event job ID for deduplication.
      return { invoice, notify: true };
    }
    if (!["unpaid", "overdue", "paid"].includes(invoice.status)) {
      return { blocked: true as const };
    }
    const [updated] = await tx
      .update(invoices)
      .set({
        paymentIntentId: event.paymentIntentId,
        status: event.kind,
        ...(event.kind === "paid"
          ? { paidAt: invoice.paidAt ?? event.occurredAt }
          : { refundedAt: invoice.refundedAt ?? event.occurredAt }),
      })
      .where(
        and(eq(invoices.id, invoice.id), eq(invoices.teamId, invoice.teamId)),
      )
      .returning();
    if (reservation) {
      await tx
        .update(invoicePaymentReservations)
        .set({
          paymentIntentId: event.paymentIntentId,
          state: "attached",
          failureCode: null,
        })
        .where(eq(invoicePaymentReservations.id, reservation.id));
    }
    return { invoice: updated!, notify: true };
  });
  if ("blocked" in result) {
    throw new InvoicePaymentError(409, "Payment event requires reconciliation");
  }
  return result;
}
