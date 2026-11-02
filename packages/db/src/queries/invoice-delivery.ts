import { and, eq, sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { invoices } from "../schema";

type InvoiceStatus = typeof invoices.$inferSelect.status;

/** Draft first sends and recurring/scheduled sends are legitimate workflows. */
export function canSendInvoiceEmail(status: InvoiceStatus): boolean {
  return (
    status === "draft" ||
    status === "scheduled" ||
    status === "unpaid" ||
    status === "overdue"
  );
}

export function canSendInvoiceReminder(status: InvoiceStatus): boolean {
  return status === "unpaid" || status === "overdue";
}

/** A delayed handoff belongs to one schedule, not every future send of a row. */
export function isCurrentInvoiceSchedule(
  invoice: { status: InvoiceStatus; scheduledJobId: string | null },
  expectedScheduledJobId: string,
): boolean {
  return (
    expectedScheduledJobId.length > 0 &&
    invoice.status === "scheduled" &&
    invoice.scheduledJobId === expectedScheduledJobId
  );
}

type AcceptedInvoiceEmail = {
  invoiceId: string;
  teamId: string;
  acceptedAt: string;
  recipient: string;
  /** Present only for an email descended from a specific delayed schedule. */
  expectedScheduledJobId?: string;
};

/**
 * Call only AFTER a provider acknowledgement. This single statement uses the
 * current row, not the status observed before an HTTP request. A racing payment,
 * cancellation or refund therefore cannot be overwritten with "unpaid".
 * Acceptance can still be recorded when the status changed while HTTP was in
 * flight; it is an audit fact, not evidence that the recipient read the email.
 */
export async function recordInvoiceEmailAccepted(
  db: DatabaseOrTransaction,
  params: AcceptedInvoiceEmail,
) {
  const { invoiceId, teamId, acceptedAt, recipient, expectedScheduledJobId } =
    params;
  const currentSchedule =
    expectedScheduledJobId === undefined
      ? sql`${invoices.status} = 'scheduled'`
      : sql`${invoices.status} = 'scheduled' and ${invoices.scheduledJobId} = ${expectedScheduledJobId}`;
  const mayTransition =
    expectedScheduledJobId === undefined
      ? sql`${invoices.status} in ('draft', 'scheduled')`
      : currentSchedule;
  const [result] = await db
    .update(invoices)
    .set({
      updatedAt: sql`now()`,
      // A response to an old schedule may still be a real acceptance, but it
      // must not consume a newer schedule or revive a canceled-to-draft one.
      status: sql`case when ${mayTransition} then 'unpaid'::invoice_status else ${invoices.status} end`,
      scheduledJobId: sql`case when ${currentSchedule} then null else ${invoices.scheduledJobId} end`,
      // Do not let an older worker completion replace a newer acknowledgement.
      sentTo: sql`case when ${invoices.sentAt} is null or ${invoices.sentAt} <= ${acceptedAt}::timestamptz then ${recipient} else ${invoices.sentTo} end`,
      sentAt: sql`greatest(${invoices.sentAt}, ${acceptedAt}::timestamptz)`,
    })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.teamId, teamId)))
    .returning({
      id: invoices.id,
      status: invoices.status,
      sentAt: invoices.sentAt,
      sentTo: invoices.sentTo,
      scheduledJobId: invoices.scheduledJobId,
    });
  return result;
}

/** Record the provider acceptance, not the time the reminder was enqueued. */
export async function recordInvoiceReminderAccepted(
  db: DatabaseOrTransaction,
  params: Omit<AcceptedInvoiceEmail, "recipient" | "expectedScheduledJobId">,
) {
  const [result] = await db
    .update(invoices)
    .set({
      updatedAt: sql`now()`,
      reminderSentAt: sql`greatest(${invoices.reminderSentAt}, ${params.acceptedAt}::timestamptz)`,
    })
    .where(
      and(
        eq(invoices.id, params.invoiceId),
        eq(invoices.teamId, params.teamId),
      ),
    )
    .returning({
      id: invoices.id,
      status: invoices.status,
      reminderSentAt: invoices.reminderSentAt,
    });
  return result;
}
