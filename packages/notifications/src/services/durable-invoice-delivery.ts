import type { Database } from "@midday/db/client";
import {
  claimInvoiceEmailDelivery,
  deferInvoiceEmailDelivery,
  deferInvoiceEmailFinalization,
  finalizeInvoiceEmailDelivery,
  getInvoiceEmailDelivery,
  type InvoiceEmailActivity,
  type InvoiceEmailDelivery,
  type InvoiceEmailDeliveryKind,
  type InvoiceEmailDeliveryScope,
  prepareInvoiceEmailDelivery,
  recordInvoiceDeliveryOutcome,
  validateInvoiceEmailEnvelope,
} from "@midday/db/queries";
import { isProductEmailTransportAvailable } from "@midday/email/config";
import type { NotificationResult } from "../base";
import { emptyEmailDeliveryResult } from "./email-delivery-result";
import type { InvoiceEnvelopeOutcome } from "./email-service";

export class InvoiceDeliveryPendingError extends Error {
  constructor() {
    super("Invoice email receipt awaits safe retry or background recovery");
    this.name = "InvoiceDeliveryPendingError";
  }
}

export class InvoiceDeliveryStoppedError extends Error {
  constructor() {
    super("Invoice email requires reconciliation; automatic replay stopped");
    this.name = "InvoiceDeliveryStoppedError";
  }
}

function result(row: InvoiceEmailDelivery): NotificationResult {
  if (row.status !== "completed" || !row.providerMessageId || !row.acceptedAt)
    throw new InvoiceDeliveryStoppedError();
  return {
    type: row.kind === "invoice" ? "invoice_sent" : "invoice_reminder_sent",
    activities: 0, // Finalized atomically in DB, not repeated by Notifications.
    emails: {
      ...emptyEmailDeliveryResult(),
      sent: 1,
      providerMessageIds: [row.providerMessageId!],
      acceptedAt: row.acceptedAt!,
      recorded: true,
    },
  };
}

async function deliverPersistedInvoiceNotificationInternal(
  db: Database,
  scope: InvoiceEmailDeliveryScope,
  send: (
    envelope: string,
    idempotencyKey: string,
  ) => Promise<InvoiceEnvelopeOutcome>,
  prepare?: () => Promise<{
    kind: InvoiceEmailDeliveryKind;
    expectedScheduledJobId?: string;
    recipient: string;
    envelope: string;
    activitySnapshot: InvoiceEmailActivity[];
  }>,
  transportAvailable: () => boolean = isProductEmailTransportAvailable,
): Promise<NotificationResult> {
  let existing = await getInvoiceEmailDelivery(db, scope);
  if (!existing && prepare) {
    existing = await prepareInvoiceEmailDelivery(db, {
      ...scope,
      ...(await prepare()),
    });
  }
  if (!existing) throw new InvoiceDeliveryStoppedError();

  const claim =
    (existing.status === "pending" || existing.status === "sending") &&
    !transportAvailable()
      ? await deferInvoiceEmailDelivery(db, scope)
      : await claimInvoiceEmailDelivery(db, scope);
  if (claim.state === "deferred") throw new InvoiceDeliveryPendingError();
  if (claim.state === "busy") throw new InvoiceDeliveryPendingError();
  if (claim.state === "missing" || claim.state === "stopped")
    throw new InvoiceDeliveryStoppedError();
  if (claim.state === "completed" && claim.delivery)
    return result(claim.delivery);
  if (claim.state === "claimed") {
    const row = claim.delivery;
    if (!row.envelope) throw new InvoiceDeliveryStoppedError();
    try {
      validateInvoiceEmailEnvelope(row.envelope, row.envelopeHash);
    } catch {
      await recordInvoiceDeliveryOutcome(
        db,
        { ...scope, leaseToken: claim.leaseToken },
        { kind: "reconciliation", code: "envelope_integrity" },
      );
      throw new InvoiceDeliveryStoppedError();
    }
    // Exactly the same wire body/key, including PDF, encryption randomness and
    // headers, is reused after a crash. No SQL lock spans this HTTP request.
    const outcome = await send(row.envelope, `agsaas-invoice/${row.id}`);
    const recorded = await recordInvoiceDeliveryOutcome(
      db,
      { ...scope, leaseToken: claim.leaseToken },
      outcome,
    );
    if (!recorded) throw new InvoiceDeliveryPendingError(); // A newer claim owns it.
    if (outcome.kind === "retry") throw new InvoiceDeliveryPendingError();
    if (outcome.kind !== "accepted") throw new InvoiceDeliveryStoppedError();
  }
  // If this transaction fails, the accepted receipt remains and the recovery
  // scanner retries finalization, without calling the provider again.
  let finalized: InvoiceEmailDelivery | null;
  try {
    finalized = await finalizeInvoiceEmailDelivery(db, scope);
  } catch {
    try {
      await deferInvoiceEmailFinalization(db, scope);
    } catch {
      /* DB outage: recovery tries later without HTTP. */
    }
    throw new InvoiceDeliveryPendingError();
  }
  if (!finalized || finalized.status !== "completed")
    throw new InvoiceDeliveryPendingError();
  return result(finalized);
}

export async function deliverPersistedInvoiceNotification(
  ...args: Parameters<typeof deliverPersistedInvoiceNotificationInternal>
): Promise<NotificationResult> {
  try {
    return await deliverPersistedInvoiceNotificationInternal(...args);
  } catch (error) {
    if (
      error instanceof InvoiceDeliveryPendingError ||
      error instanceof InvoiceDeliveryStoppedError
    )
      throw error;
    // Drizzle errors can contain bound HTML/PDF/recipient parameters. Do not
    // send the original error/cause to BullMQ, logs or Sentry. The durable state
    // determines whether the next attempt sends or only finalizes a receipt.
    throw new InvoiceDeliveryPendingError();
  }
}
