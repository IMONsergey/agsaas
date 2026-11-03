import { randomUUID } from "node:crypto";
import { InvoiceFinancialStateError } from "@midday/invoice/calculate";
import { and, eq } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import {
  financialJobOperationKey,
  financialRequestHash,
} from "../financial-job";
import { invoices, customers } from "../schema";
import { InvoicePaymentError } from "../errors";
import {
  confirmInvoicePaid,
  getInvoiceSettlementEntries,
} from "./invoice-settlements";
import { ensureFinancialJobDispatch } from "./financial-job-dispatches";
import {
  updateInvoice,
  deleteInvoice,
  getInvoiceDocumentById,
  type UpdateInvoiceParams,
} from "./invoices";

type InvoiceScope = { id: string; teamId: string; userId?: string };

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}

async function commandPreviewFromLockedInvoice(
  db: DatabaseOrTransaction,
  current: typeof invoices.$inferSelect,
) {
  const document = await getInvoiceDocumentById(db, {
    id: current.id,
    teamId: current.teamId,
  });
  if (!document) throw new Error("Locked invoice disappeared");
  const customer = current.customerId
    ? (
        await db
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.id, current.customerId),
              eq(customers.teamId, current.teamId),
            ),
          )
      )[0]
    : undefined;
  const settlementRevision = (
    await getInvoiceSettlementEntries(db, current.teamId, current.id)
  ).map((row) => ({ id: row.id, requestHash: row.requestHash }));
  const template = document.template as Record<string, unknown> | null;
  const recipient = current.sentTo?.trim() || customer?.email?.trim() || null;
  const bcc = [
    ...new Set([
      ...(customer?.billingEmail
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
      ...(template?.sendCopy && document.user?.email
        ? [document.user.email.trim()]
        : []),
    ]),
  ];
  const replyTo = document.team?.email?.trim() || undefined;
  return {
    invoiceId: current.id,
    revision: financialRequestHash({
      version: 2,
      invoice: current,
      settlementRevision,
      customer: customer ?? null,
      copyEmail: document.user?.email ?? null,
      replyTo,
    }),
    recipient,
    bcc,
    replyTo,
    customerName: document.customerName || customer?.name || null,
    amount: document.amount,
    currency: document.currency,
    invoiceNumber: document.invoiceNumber,
    status: document.status,
  };
}

/** A preview is current primary state; it does not reserve or approve an action. */
export async function getInvoiceCommandPreview(
  db: DatabaseOrTransaction,
  input: InvoiceScope,
) {
  return primary(db).transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.id), eq(invoices.teamId, input.teamId)))
      .for("update");
    return current ? commandPreviewFromLockedInvoice(tx, current) : undefined;
  });
}

/** Safe for an outer transaction that consumes the approval and commits the mutation together. */
export async function deleteInvoiceWithRevision(
  db: DatabaseOrTransaction,
  input: InvoiceScope & { expectedRevision: string },
) {
  return primary(db).transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.id), eq(invoices.teamId, input.teamId)))
      .for("update");
    if (!current) return undefined;
    const preview = await commandPreviewFromLockedInvoice(tx, current);
    if (preview.revision !== input.expectedRevision)
      throw new InvoiceFinancialStateError(
        "Invoice changed after preview; review the current version again",
      );
    return deleteInvoice(tx, input);
  });
}

/** Status, immutable document and queue intent commit together. Redis is not a prerequisite. */
export async function issueInvoice(
  db: DatabaseOrTransaction,
  input: InvoiceScope & {
    deliveryType: "create" | "create_and_send";
    sentTo?: string | null;
    expectedRevision?: string;
  },
) {
  return primary(db).transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.id), eq(invoices.teamId, input.teamId)))
      .for("update");
    if (!current) return undefined;
    const approved =
      input.expectedRevision === undefined
        ? undefined
        : await commandPreviewFromLockedInvoice(tx, current);
    if (approved && approved.revision !== input.expectedRevision)
      throw new InvoiceFinancialStateError(
        "Invoice changed after preview; review the current version again",
      );
    if (
      approved &&
      input.deliveryType === "create_and_send" &&
      (!approved.recipient ||
        !approved.customerName ||
        input.sentTo !== approved.recipient)
    )
      throw new InvoiceFinancialStateError(
        "Approved invoice recipient must match the exact reviewed address",
      );
    if (!["draft", "scheduled", "unpaid", "overdue"].includes(current.status)) {
      throw new InvoiceFinancialStateError(
        "A finalized invoice cannot be issued again",
      );
    }
    if (
      input.sentTo !== undefined &&
      current.sentTo !== input.sentTo &&
      !["draft", "scheduled"].includes(current.status)
    ) {
      throw new InvoiceFinancialStateError(
        "An issued delivery recipient cannot be replaced by a retry",
      );
    }
    const updated = await updateInvoice(tx, {
      id: input.id,
      teamId: input.teamId,
      userId: input.userId,
      // An overdue invoice remains overdue when an idempotent request is replayed.
      status: current.status === "overdue" ? undefined : "unpaid",
      scheduledAt: null,
      scheduledJobId: null,
      ...(input.sentTo === undefined ? {} : { sentTo: input.sentTo }),
    });
    if (!updated) throw new Error("Locked invoice disappeared");
    const source = `invoice/${input.id}/issue/${input.deliveryType}`;
    const operation = await ensureFinancialJobDispatch(tx, {
      teamId: input.teamId,
      jobName: "generate-invoice",
      source,
      payload: {
        teamId: input.teamId,
        invoiceId: input.id,
        deliveryType: input.deliveryType,
        deliveryKey: financialJobOperationKey("generate-invoice", source),
        ...(approved && input.deliveryType === "create_and_send"
          ? {
              approvedRecipients: {
                recipient: approved.recipient!,
                bcc: approved.bcc,
                customerName: approved.customerName!,
                ...(approved.replyTo ? { replyTo: approved.replyTo } : {}),
              },
            }
          : {}),
      },
    });
    return {
      ...updated,
      operation: { id: operation.id, status: operation.status },
    };
  });
}

/** Each committed marker is a schedule generation. Older queued work becomes harmless. */
export async function scheduleInvoice(
  db: DatabaseOrTransaction,
  input: InvoiceScope & { scheduledAt: string; requireScheduled?: boolean },
) {
  const when = new Date(input.scheduledAt);
  if (!Number.isFinite(when.getTime()) || when.getTime() <= Date.now()) {
    throw new InvoiceFinancialStateError(
      "scheduledAt must be a valid future time",
    );
  }
  const scheduledAt = when.toISOString();
  return primary(db).transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.id), eq(invoices.teamId, input.teamId)))
      .for("update");
    if (!current) return undefined;
    if (
      !["draft", "scheduled"].includes(current.status) ||
      (input.requireScheduled && current.status !== "scheduled")
    ) {
      throw new InvoiceFinancialStateError(
        "Only a draft or currently scheduled invoice can be scheduled",
      );
    }
    // A retry of the same persisted schedule reuses its generation and delivery identity.
    const marker =
      current.status === "scheduled" &&
      current.scheduledAt &&
      new Date(current.scheduledAt).getTime() === when.getTime() &&
      current.scheduledJobId?.startsWith("invoices:schedule-")
        ? current.scheduledJobId
        : `invoices:schedule-${randomUUID()}`;
    const source = `invoice/${input.id}/schedule/${marker}`;
    const updated = await updateInvoice(tx, {
      id: input.id,
      teamId: input.teamId,
      userId: input.userId,
      status: "scheduled",
      scheduledAt,
      scheduledJobId: marker,
    });
    if (!updated) throw new Error("Locked invoice disappeared");
    const operation = await ensureFinancialJobDispatch(tx, {
      teamId: input.teamId,
      jobName: "generate-invoice",
      source,
      payload: {
        teamId: input.teamId,
        invoiceId: input.id,
        deliveryType: "create_and_send",
        notBefore: scheduledAt,
        expectedScheduledJobId: marker,
        deliveryKey: financialJobOperationKey("generate-invoice", source),
      },
    });
    await ensureFinancialJobDispatch(tx, {
      teamId: input.teamId,
      jobName: "notification",
      source: `${source}/notification`,
      payload: {
        type: "invoice_scheduled",
        teamId: input.teamId,
        invoiceId: input.id,
        invoiceNumber: updated.invoiceNumber,
        scheduledAt,
        ...(updated.customerName ? { customerName: updated.customerName } : {}),
      },
    });
    return {
      ...updated,
      operation: { id: operation.id, status: operation.status },
    };
  });
}

/** Commit invalidation before touching any queue. No queue deletion is required for correctness. */
export async function cancelInvoiceSchedule(
  db: DatabaseOrTransaction,
  input: InvoiceScope,
) {
  return primary(db).transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.id), eq(invoices.teamId, input.teamId)))
      .for("update");
    if (!current) return undefined;
    if (current.status === "draft" && !current.scheduledJobId) return current;
    if (current.status !== "scheduled") {
      throw new InvoiceFinancialStateError(
        "Only a currently scheduled invoice can be unscheduled",
      );
    }
    return updateInvoice(tx, {
      ...input,
      status: "draft",
      scheduledAt: null,
      scheduledJobId: null,
    });
  });
}

/** Public status edits must use the same durable commands as the dedicated issue/schedule endpoints. */
export async function updateInvoiceWithIntent(
  db: DatabaseOrTransaction,
  input: Pick<
    UpdateInvoiceParams,
    | "id"
    | "teamId"
    | "userId"
    | "status"
    | "paidAt"
    | "internalNote"
    | "scheduledAt"
  >,
) {
  return primary(db).transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.id), eq(invoices.teamId, input.teamId)))
      .for("update");
    if (!current) return undefined;
    const { status, scheduledAt, ...rest } = input;
