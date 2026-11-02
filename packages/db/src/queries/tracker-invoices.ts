import { InvoiceFinancialStateError } from "@midday/invoice/calculate";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { invoices, trackerEntries, trackerInvoiceAllocations } from "../schema";

/** Must be called within the transaction that creates the draft and its allocations. */
export async function getUnbilledTrackerEntriesForInvoice(
  db: DatabaseOrTransaction,
  params: { teamId: string; projectId: string; from: string; to: string },
) {
  return db
    .select()
    .from(trackerEntries)
    .where(
      and(
        eq(trackerEntries.teamId, params.teamId),
        eq(trackerEntries.projectId, params.projectId),
        gte(trackerEntries.date, params.from),
        lte(trackerEntries.date, params.to),
        or(eq(trackerEntries.billed, false), isNull(trackerEntries.billed)),
        // Running timers cannot be allocated. Duration-only legacy entries remain usable.
        or(isNotNull(trackerEntries.stop), isNull(trackerEntries.start)),
        gt(trackerEntries.duration, 0),
        gt(trackerEntries.rate, 0),
        isNotNull(trackerEntries.currency),
        sql`not exists (select 1 from ${trackerInvoiceAllocations} where ${trackerInvoiceAllocations.trackerEntryId} = ${trackerEntries.id})`,
      ),
    )
    .orderBy(asc(trackerEntries.id))
    .for("update");
}

/** The unique entry key is the final guard even if another writer omits the read lock. */
export async function allocateTrackerEntriesToInvoice(
  db: DatabaseOrTransaction,
  params: { teamId: string; invoiceId: string; entryIds: string[] },
) {
  const ids = [...new Set(params.entryIds)];
  if (!ids.length || ids.length !== params.entryIds.length)
    throw new InvoiceFinancialStateError(
      "No unbilled tracked time is available",
    );
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.id, params.invoiceId),
        eq(invoices.teamId, params.teamId),
      ),
    )
    .for("update");
  if (!invoice || invoice.status !== "draft" || invoice.documentSnapshot)
    throw new InvoiceFinancialStateError(
      "Tracked time can only be allocated to an unissued draft",
    );
  const entries = await db
    .select()
    .from(trackerEntries)
    .where(
      and(
        eq(trackerEntries.teamId, params.teamId),
        inArray(trackerEntries.id, ids),
      ),
    )
    .orderBy(asc(trackerEntries.id))
    .for("update");
  if (
    entries.length !== ids.length ||
    entries.some(
      (entry) =>
        entry.billed ||
        (entry.start && !entry.stop) ||
        !entry.duration ||
        entry.duration <= 0 ||
        !entry.rate ||
        entry.rate <= 0 ||
        entry.currency?.toUpperCase() !== invoice.currency?.toUpperCase(),
    )
  )
    throw new InvoiceFinancialStateError(
      "Tracked time is already allocated or no longer billable",
    );
  await db.insert(trackerInvoiceAllocations).values(
    entries.map((entry) => ({
      teamId: params.teamId,
      invoiceId: params.invoiceId,
      trackerEntryId: entry.id,
      duration: entry.duration!,
      rate: entry.rate!,
      currency: entry.currency!.toUpperCase(),
    })),
  );
  await db
    .update(trackerEntries)
    .set({ billed: true })
    .where(
      and(
        eq(trackerEntries.teamId, params.teamId),
        inArray(trackerEntries.id, ids),
      ),
    );
}

export async function releaseDraftTrackerAllocations(
  db: DatabaseOrTransaction,
  params: { teamId: string; invoiceId: string },
) {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.id, params.invoiceId),
        eq(invoices.teamId, params.teamId),
      ),
    )
    .for("update");
  if (
    !invoice ||
    invoice.documentSnapshot ||
    !["draft", "canceled"].includes(invoice.status)
  )
    throw new InvoiceFinancialStateError(
      "Issued tracked time must remain linked to its invoice",
    );
  const entries = await db
    .delete(trackerInvoiceAllocations)
    .where(
      and(
        eq(trackerInvoiceAllocations.teamId, params.teamId),
        eq(trackerInvoiceAllocations.invoiceId, params.invoiceId),
      ),
    )
    .returning({ id: trackerInvoiceAllocations.trackerEntryId });
  if (entries.length)
    await db
      .update(trackerEntries)
      .set({ billed: false })
      .where(
        and(
          eq(trackerEntries.teamId, params.teamId),
          inArray(
            trackerEntries.id,
            entries.map((row) => row.id),
          ),
        ),
      );
}

export async function assertTrackerEntryMutable(
  db: DatabaseOrTransaction,
  teamId: string,
  id: string,
) {
  const [entry] = await db
    .select()
    .from(trackerEntries)
    .where(and(eq(trackerEntries.id, id), eq(trackerEntries.teamId, teamId)))
    .for("update");
  if (!entry) return null;
  const [allocation] = await db
    .select({ id: trackerInvoiceAllocations.trackerEntryId })
    .from(trackerInvoiceAllocations)
    .where(
      and(
        eq(trackerInvoiceAllocations.trackerEntryId, id),
        eq(trackerInvoiceAllocations.teamId, teamId),
      ),
    )
    .limit(1);
  if (entry.billed || allocation)
    throw new InvoiceFinancialStateError(
      "This tracked time is allocated to an invoice and cannot be changed",
    );
  return entry;
}
