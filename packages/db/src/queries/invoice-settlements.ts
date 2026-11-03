import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { InvoicePaymentError } from "../errors";
import {
  financialJobOperationKey,
  financialRequestHash,
} from "../financial-job";
import {
  calculateInvoiceSettlement,
  exactMinor,
  type SettlementEntry,
  type SettlementKind,
} from "../invoice-settlement";
import { invoices, invoicePaymentReservations } from "../schema";
import { ensureFinancialJobDispatch } from "./financial-job-dispatches";
import { getInvoiceLedgerAmount } from "../invoice-money";
import { prepareInvoiceDocument } from "./invoices";

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}
type StoredEntry = SettlementEntry & {
  teamId: string;
  invoiceId: string;
  operationKey: string;
  requestHash: string;
  provider: "manual" | "stripe" | "bank";
  providerAccountId: string;
  providerResourceId: string;
  actorId: string | null;
  reason: string;
  createdAt: string;
};
const columns = sql`id,team_id as "teamId",invoice_id as "invoiceId",operation_key as "operationKey",request_hash as "requestHash",kind,
  amount_minor::text as "amountMinor",currency,payment_id as "paymentId",reverses_id as "reversesId",provider,
  provider_account_id as "providerAccountId",provider_resource_id as "providerResourceId",actor_id as "actorId",reason,
  occurred_at::text as "occurredAt",created_at::text as "createdAt"`;
export async function getInvoiceSettlementEntries(
  db: DatabaseOrTransaction,
  teamId: string,
  invoiceId: string,
) {
  return (
    await db.execute<StoredEntry>(sql`select ${columns} from invoice_settlement_entries
    where team_id=${teamId}::uuid and invoice_id=${invoiceId}::uuid order by occurred_at,id`)
  ).rows;
}

export type RecordInvoiceSettlementInput = {
  invoiceId: string;
  teamId: string;
  operationKey: string;
  kind: SettlementKind;
  amountMinor: string;
  currency: string;
  paymentId?: string;
  reversesId?: string;
  provider: "manual" | "stripe" | "bank";
  providerAccountId: string;
  providerResourceId: string;
  occurredAt?: string;
  actorId?: string;
  reason: string;
};
function validate(input: RecordInvoiceSettlementInput) {
  try {
    exactMinor(input.amountMinor);
  } catch {
    throw new InvoicePaymentError(
      400,
      "Amount must be positive exact minor units",
    );
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.operationKey) ||
    !/^[a-z]{3}$/.test(input.currency) ||
    !["manual", "stripe", "bank"].includes(input.provider) ||
    !input.reason.trim() ||
    input.reason.length > 1000 ||
    [input.providerAccountId, input.providerResourceId].some(
      (value) =>
        !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value),
    ) ||
    (input.occurredAt !== undefined &&
      !Number.isFinite(Date.parse(input.occurredAt)))
  )
    throw new InvoicePaymentError(400, "Invalid confirmed settlement entry");
  if (input.provider === "manual" && input.providerAccountId !== input.teamId)
    throw new InvoicePaymentError(
      400,
      "Manual settlement account must be its team",
    );
}
async function lockedInvoice(
  db: DatabaseOrTransaction,
  input: { invoiceId: string; teamId: string },
) {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.id, input.invoiceId), eq(invoices.teamId, input.teamId)),
    )
    .for("update");
  if (!invoice) throw new InvoicePaymentError(404, "Invoice not found");
  return invoice;
}
function invoiceStatus(
  invoice: typeof invoices.$inferSelect,
  projection: ReturnType<typeof calculateInvoiceSettlement>,
) {
  // Settlement state and collection age are different dimensions.
  return projection.status === "unpaid" && invoice.status === "overdue"
    ? ("overdue" as const)
    : projection.status;
}
async function persistProjection(
  db: DatabaseOrTransaction,
  invoice: typeof invoices.$inferSelect,
  rows: StoredEntry[],
) {
  const amount = getInvoiceLedgerAmount(invoice.amount, invoice.currency);
  const projection = calculateInvoiceSettlement(
    String(amount.amountMinor),
    amount.currency,
    rows,
  );
  await db.execute(sql`insert into invoice_settlement_state(invoice_id,team_id,projection,entry_count)
    values(${invoice.id}::uuid,${invoice.teamId}::uuid,${JSON.stringify(projection)}::jsonb,${rows.length})
    on conflict(invoice_id) do update set projection=excluded.projection,entry_count=excluded.entry_count,
      updated_at=clock_timestamp(),reconciliation_required=false,reason=null`);
  if (!rows.length)
    throw new InvoicePaymentError(
      409,
      "A projection needs confirmed settlement evidence",
    );
  const latest = rows.reduce(
    (at, row) =>
      Date.parse(row.occurredAt) > Date.parse(at) ? row.occurredAt : at,
    rows[0]!.occurredAt,
  );
  await db
    .update(invoices)
    .set({
      status: invoiceStatus(invoice, projection),
      paidAt:
        projection.status === "paid"
          ? (invoice.paidAt ?? latest)
          : invoice.paidAt,
      refundedAt:
        projection.status === "refunded"
          ? (invoice.refundedAt ?? latest)
          : invoice.refundedAt,
      scheduledAt: null,
      scheduledJobId: null,
    })
    .where(
      and(eq(invoices.id, invoice.id), eq(invoices.teamId, invoice.teamId)),
    );
  return projection;
}

/** Confirmed evidence only. Provider authorization belongs to its adapter; this function enforces money invariants. */
export async function recordInvoiceSettlement(
  db: DatabaseOrTransaction,
  input: RecordInvoiceSettlementInput,
) {
  validate(input);
  const { occurredAt, actorId, reason, ...financialIdentity } = input;
  // Provider resource identities remain stable across deliveries and observation timestamps.
  const requestHash = financialRequestHash(
    input.provider === "stripe" ? financialIdentity : input,
  );
  return primary(db).transaction(async (tx) => {
    const invoice = await lockedInvoice(tx, input);
    if (invoice.status === "canceled")
      throw new InvoicePaymentError(
        409,
        "A canceled invoice requires payment reconciliation",
      );
    const prior = await getInvoiceSettlementEntries(
      tx,
      input.teamId,
      input.invoiceId,
    );
    const replay = prior.find((row) => row.operationKey === input.operationKey);
    if (replay) {
      if (replay.requestHash !== requestHash)
        throw new InvoicePaymentError(
          409,
          "Settlement operation identity conflict",
        );
      return {
        entry: replay,
        projection: await persistProjection(tx, invoice, prior),
        replayed: true,
      };
    }
    const money = getInvoiceLedgerAmount(invoice.amount, invoice.currency);
    if (input.currency !== money.currency)
      throw new InvoicePaymentError(
        409,
        "Settlement currency does not match invoice",
      );
    if (input.provider !== "stripe") {
      if (
        !prior.length &&
        (invoice.status === "paid" ||
          invoice.status === "refunded" ||
          invoice.paidAt ||
          invoice.refundedAt)
      )
        throw new InvoicePaymentError(
          409,
          "Legacy settlement history requires confirmed reconciliation",
        );
      const reservations = await tx
        .select({ id: invoicePaymentReservations.id })
        .from(invoicePaymentReservations)
        .where(
          and(
            eq(invoicePaymentReservations.invoiceId, invoice.id),
            sql`${invoicePaymentReservations.state} <> 'settled'`,
          ),
        )
        .limit(1);
      if (reservations.length)
        throw new InvoicePaymentError(
          409,
          "Reconcile the reserved provider payment before recording outside money",
        );
    }
    if (input.kind !== "payment") {
      const payment = prior.find(
        (row) => row.id === input.paymentId && row.kind === "payment",
      );
      if (
        !payment ||
        payment.provider !== input.provider ||
        payment.providerAccountId !== input.providerAccountId
      )
        throw new InvoicePaymentError(
          409,
          "Refund does not belong to this original payment",
        );
    }
    const clock = (
      await tx.execute<{ at: string }>(
        sql`select clock_timestamp()::text as at`,
      )
    ).rows[0]!.at;
    if (
      input.provider !== "stripe" &&
      input.occurredAt &&
      Date.parse(input.occurredAt) > Date.parse(clock) + 300000
    )
      throw new InvoicePaymentError(
        400,
        "A confirmed settlement date cannot be in the future",
      );
    const candidate: StoredEntry = {
      id: randomUUID(),
      teamId: input.teamId,
      invoiceId: input.invoiceId,
      operationKey: input.operationKey,
      requestHash,
      kind: input.kind,
      amountMinor: input.amountMinor,
      currency: input.currency,
      paymentId: input.paymentId ?? null,
      reversesId: input.reversesId ?? null,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      providerResourceId: input.providerResourceId,
      actorId: input.actorId ?? null,
      reason: input.reason,
      occurredAt: input.occurredAt ?? clock,
      createdAt: clock,
    };
    try {
      calculateInvoiceSettlement(String(money.amountMinor), money.currency, [
        ...prior,
        candidate,
      ]);
    } catch (error) {
      throw new InvoicePaymentError(
        409,
        error instanceof Error ? error.message : "Settlement invariant failed",
      );
    }
    await tx.execute(sql`insert into invoice_settlement_entries
      (id,team_id,invoice_id,operation_key,request_hash,kind,amount_minor,currency,payment_id,reverses_id,provider,provider_account_id,provider_resource_id,occurred_at,actor_id,reason)
      values(${candidate.id}::uuid,${input.teamId}::uuid,${input.invoiceId}::uuid,${input.operationKey},${requestHash},${input.kind},
        ${input.amountMinor}::bigint,${input.currency},${input.paymentId ?? null}::uuid,${input.reversesId ?? null}::uuid,
        ${input.provider},${input.providerAccountId},${input.providerResourceId},${candidate.occurredAt}::timestamptz,${input.actorId ?? null}::uuid,${input.reason})`);
    await prepareInvoiceDocument(tx, {
      id: invoice.id,
      teamId: invoice.teamId,
    });
    const projection = await persistProjection(tx, invoice, [
      ...prior,
      candidate,
    ]);
    if (!invoice.filePath) {
      const source = `invoice/${invoice.id}/issue/create`;
      await ensureFinancialJobDispatch(tx, {
        teamId: invoice.teamId,
        jobName: "generate-invoice",
        source,
        payload: {
          teamId: invoice.teamId,
          invoiceId: invoice.id,
          deliveryType: "create",
          deliveryKey: financialJobOperationKey("generate-invoice", source),
        },
      });
    }
    return { entry: candidate, projection, replayed: false };
  });
}

export async function getInvoiceSettlement(
  db: DatabaseOrTransaction,
  input: { invoiceId: string; teamId: string },
) {
  return primary(db).transaction(async (tx) => {
    const invoice = await lockedInvoice(tx, input);
    const rows = await getInvoiceSettlementEntries(
      tx,
      input.teamId,
      input.invoiceId,
    );
    const money = getInvoiceLedgerAmount(invoice.amount, invoice.currency);
    const legacy =
      rows.length === 0 &&
      !!(
        invoice.paidAt ||
        invoice.refundedAt ||
        ["paid", "refunded"].includes(invoice.status)
      );
    const stored = (
      await tx.execute<{
        projection: unknown;
        reconciliation_required: boolean;
        reason: string | null;
      }>(
        sql`select projection,reconciliation_required,reason from invoice_settlement_state where invoice_id=${input.invoiceId}::uuid and team_id=${input.teamId}::uuid`,
      )
    ).rows[0];
    return {
      entries: rows,
      projection: legacy
        ? null
        : calculateInvoiceSettlement(
            String(money.amountMinor),
            money.currency,
            rows,
          ),
      reconciliationRequired:
        legacy || stored?.reconciliation_required === true,
      reason: legacy
        ? "Legacy paid/refunded state has no confirmed ledger evidence"
        : (stored?.reason ?? null),
    };
  });
}

/** Rebuild cached balances from immutable evidence; never creates payment or refund history. */
export async function reconcileInvoiceSettlement(
  db: DatabaseOrTransaction,
  input: { invoiceId: string; teamId: string; apply?: boolean },
) {
  return primary(db).transaction(async (tx) => {
    const invoice = await lockedInvoice(tx, input);
    const rows = await getInvoiceSettlementEntries(
      tx,
      input.teamId,
      input.invoiceId,
    );
    if (!rows.length)
      return { state: "requires_evidence" as const, changed: false };
    const money = getInvoiceLedgerAmount(invoice.amount, invoice.currency);
    const expected = calculateInvoiceSettlement(
      String(money.amountMinor),
      money.currency,
      rows,
    );
    const stored = (
      await tx.execute<{ projection: unknown }>(
        sql`select projection from invoice_settlement_state where team_id=${input.teamId}::uuid and invoice_id=${input.invoiceId}::uuid`,
      )
    ).rows[0];
    const drift =
      financialRequestHash(stored?.projection) !==
        financialRequestHash(expected) ||
      invoice.status !== invoiceStatus(invoice, expected);
    if (input.apply && invoice.status === "canceled")
      return { state: "requires_evidence" as const, changed: false };
    if (input.apply && drift) await persistProjection(tx, invoice, rows);
    return {
      state: drift ? ("drift" as const) : ("consistent" as const),
      changed: input.apply === true && drift,
      expected,
    };
  });
}

/** Stable receipt for the legacy Mark paid action. Subsequent corrections use explicit journal operations. */
export async function confirmInvoicePaid(
  db: DatabaseOrTransaction,
  input: {
    invoiceId: string;
    teamId: string;
    actorId?: string;
    occurredAt?: string;
  },
) {
  return primary(db).transaction(async (tx) => {
    await lockedInvoice(tx, input);
    const current = await getInvoiceSettlement(tx, input);
    if (current.reconciliationRequired || !current.projection)
      throw new InvoicePaymentError(
        409,
        "Existing settlement history requires reconciliation",
      );
    if (current.projection.invoiceAmountMinor === "0")
      throw new InvoicePaymentError(
        400,
        "A zero-amount invoice cannot record a payment",
      );
    if (current.projection.balanceMinor === "0") return current;
    const source = `manual-complete/${input.invoiceId}/v1`;
    return recordInvoiceSettlement(tx, {
      ...input,
      operationKey: financialRequestHash(source),
      kind: "payment",
      amountMinor: current.projection.balanceMinor,
      currency: current.projection.currency,
      provider: "manual",
      providerAccountId: input.teamId,
      providerResourceId: source,
      reason: "Confirmed received through Mark paid",
    });
  });
}
