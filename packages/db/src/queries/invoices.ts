import {
  invoiceReceivedAmount,
  invoiceOutstandingAmount,
} from "../invoice-settlement-sql";
import { UTCDate } from "@date-fns/utc";
import { buildSearchQuery } from "@midday/db/utils/search-query";
import {
  calculateInvoiceAmounts,
  getInvoiceMoneyTemplate,
  hasInvoiceFinancialChanges,
  InvoiceAmountError,
  InvoiceFinancialStateError,
  validateInvoiceMoney,
} from "@midday/invoice/calculate";
import { generateToken } from "@midday/invoice/token";
import type { EditorDoc, LineItem } from "@midday/invoice/types";
import camelcaseKeys from "camelcase-keys";
import {
  addMonths,
  eachMonthOfInterval,
  endOfMonth,
  format,
  parseISO,
  startOfMonth,
} from "date-fns";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm/sql/sql";
import { v4 as uuidv4 } from "uuid";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  applyInvoiceDocument,
  captureInvoiceDocument,
  hasInvoiceIdentityChanges,
} from "../invoice-document";
import {
  type activityTypeEnum,
  customers,
  invoicePaymentReservations,
  invoiceRecurring,
  invoiceStatusEnum,
  invoices,
  invoiceTemplates,
  teams,
  trackerEntries,
  trackerProjects,
  users,
} from "../schema";
import { logActivity } from "../utils/log-activity";
import {
  assertTeamOwnership,
  TenantResourceNotFoundError,
} from "../utils/tenant-ownership";
import { getExchangeRatesBatch } from "./exhange-rates";
import { isCurrentInvoiceSchedule } from "./invoice-delivery";
import { releaseDraftTrackerAllocations } from "./tracker-invoices";

export type Template = {
  id?: string; // Reference to invoice_templates table
  name?: string; // Template name for display
  isDefault?: boolean; // Whether this is the default template
  customerLabel: string;
  title: string;
  fromLabel: string;
  invoiceNoLabel: string;
  issueDateLabel: string;
  dueDateLabel: string;
  descriptionLabel: string;
  priceLabel: string;
  quantityLabel: string;
  totalLabel: string;
  totalSummaryLabel: string;
  vatLabel: string;
  subtotalLabel: string;
  taxLabel: string;
  discountLabel: string;
  timezone: string;
  paymentLabel: string;
  noteLabel: string;
  logoUrl: string | null;
  currency: string;
  paymentDetails: EditorDoc | null;
  fromDetails: EditorDoc | null;
  noteDetails: EditorDoc | null;
  dateFormat: string;
  includeVat: boolean;
  includeTax: boolean;
  includeDiscount: boolean;
  includeDecimals: boolean;
  includeUnits: boolean;
  includeQr: boolean;
  taxRate: number;
  vatRate: number;
  size: "a4" | "letter";
  deliveryType: "create" | "create_and_send" | "scheduled";
  locale: string;
  paymentEnabled?: boolean;
  paymentTermsDays?: number;
};

export type GetInvoicesParams = {
  teamId: string;
  cursor?: string | null;
  pageSize?: number;
  q?: string | null;
  statuses?: string[] | null;
  customers?: string[] | null;
  start?: string | null;
  end?: string | null;
  sort?: string[] | null;
  ids?: string[] | null;
  recurringIds?: string[] | null;
  recurring?: boolean | null;
};

export async function getInvoices(db: Database, params: GetInvoicesParams) {
  const {
    teamId,
    sort,
    cursor,
    pageSize = 25,
    q,
    statuses,
    start,
    end,
    customers: customerIds,
    ids,
    recurringIds,
    recurring,
  } = params;

  const whereConditions: SQL[] = [eq(invoices.teamId, teamId)];

  // Apply IDs filter
  if (ids && ids.length > 0) {
    whereConditions.push(inArray(invoices.id, ids));
  }

  // Apply recurring series IDs filter (shows all invoices from these recurring series)
  if (recurringIds && recurringIds.length > 0) {
    whereConditions.push(inArray(invoices.invoiceRecurringId, recurringIds));
  }

  // Apply recurring filter (shows all invoices that are/aren't part of a recurring series)
  if (recurring === true) {
    whereConditions.push(isNotNull(invoices.invoiceRecurringId));
  } else if (recurring === false) {
    whereConditions.push(isNull(invoices.invoiceRecurringId));
  }

  // Apply status filter
  if (statuses && statuses.length > 0) {
    // Cast the statuses array to the correct enum type
    const validStatuses = statuses.filter((status) =>
      invoiceStatusEnum.enumValues.includes(
        status as (typeof invoiceStatusEnum.enumValues)[number],
      ),
    ) as (typeof invoiceStatusEnum.enumValues)[number][];

    if (validStatuses.length > 0) {
      whereConditions.push(inArray(invoices.status, validStatuses));
    }
  }

  // Apply date range filter
  if (start && end) {
    whereConditions.push(gte(invoices.dueDate, start));
    whereConditions.push(lte(invoices.dueDate, end));
  }

  // Apply customer filter
  if (customerIds && customerIds.length > 0) {
    whereConditions.push(inArray(invoices.customerId, customerIds));
  }

  // Apply search query filter
  if (q) {
    const searchConditions: SQL[] = [
      sql`to_tsquery('english', ${buildSearchQuery(q)}) @@ ${invoices.fts}`,
      sql`${invoices.invoiceNumber} ILIKE '%' || ${q} || '%'`,
      sql`${invoices.customerName} ILIKE '%' || ${q} || '%'`,
    ];
    // Numeric prefixes such as 2026-001 are invoice numbers, not NaN amounts.
    // Even a fully numeric query can be an invoice number or customer name.
    if (
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(q.trim()) &&
      Number.isFinite(Number(q))
    ) {
      searchConditions.push(eq(invoices.amount, Number(q)));
    }
    whereConditions.push(or(...searchConditions)!);
  }

  // Start building the query – excludes heavy JSONB blobs not needed for
  // list views (paymentDetails, customerDetails, noteDetails, fromDetails,
  // topBlock, bottomBlock). Use getInvoiceById for full data.
  const query = db
    .select({
      id: invoices.id,
      dueDate: invoices.dueDate,
      invoiceNumber: invoices.invoiceNumber,
      createdAt: invoices.createdAt,
      amount: invoices.amount,
      currency: invoices.currency,
      lineItems: invoices.lineItems,
      reminderSentAt: invoices.reminderSentAt,
      updatedAt: invoices.updatedAt,
      note: invoices.note,
      internalNote: invoices.internalNote,
      paidAt: invoices.paidAt,
      vat: invoices.vat,
      tax: invoices.tax,
      filePath: invoices.filePath,
      status: invoices.status,
      fileSize: invoices.fileSize,
      viewedAt: invoices.viewedAt,
      issueDate: invoices.issueDate,
      sentAt: invoices.sentAt,
      template: invoices.template,
      customerName: invoices.customerName,
      token: invoices.token,
      sentTo: invoices.sentTo,
      discount: invoices.discount,
      subtotal: invoices.subtotal,
      scheduledAt: invoices.scheduledAt,
      scheduledJobId: invoices.scheduledJobId,
      customer: {
        id: customers.id,
        name: customers.name,
        website: customers.website,
        email: customers.email,
      },
      customerId: invoices.customerId,
      team: {
        name: teams.name,
      },
      // Recurring invoice fields
      invoiceRecurringId: invoices.invoiceRecurringId,
      recurringSequence: invoices.recurringSequence,
      recurring: {
        id: invoiceRecurring.id,
        status: invoiceRecurring.status,
        frequency: invoiceRecurring.frequency,
        frequencyInterval: invoiceRecurring.frequencyInterval,
        endType: invoiceRecurring.endType,
        endCount: invoiceRecurring.endCount,
        invoicesGenerated: invoiceRecurring.invoicesGenerated,
        nextScheduledAt: invoiceRecurring.nextScheduledAt,
      },
    })
    .from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .leftJoin(teams, eq(invoices.teamId, teams.id))
    .leftJoin(
      invoiceRecurring,
      eq(invoices.invoiceRecurringId, invoiceRecurring.id),
    )
    .where(and(...whereConditions));

  // Apply sorting
  if (sort && sort.length === 2) {
    const [column, direction] = sort;
    const isAscending = direction === "asc";

    if (column === "customer") {
      isAscending
        ? query.orderBy(asc(customers.name))
        : query.orderBy(desc(customers.name));
    } else if (column === "created_at") {
      isAscending
        ? query.orderBy(asc(invoices.createdAt))
        : query.orderBy(desc(invoices.createdAt));
    } else if (column === "due_date") {
      isAscending
        ? query.orderBy(asc(invoices.dueDate))
        : query.orderBy(desc(invoices.dueDate));
    } else if (column === "amount") {
      isAscending
        ? query.orderBy(asc(invoices.amount))
        : query.orderBy(desc(invoices.amount));
    } else if (column === "status") {
      isAscending
        ? query.orderBy(asc(invoices.status))
        : query.orderBy(desc(invoices.status));
    } else if (column === "invoice_number") {
      isAscending
        ? query.orderBy(asc(invoices.invoiceNumber))
        : query.orderBy(desc(invoices.invoiceNumber));
    } else if (column === "issue_date") {
      isAscending
        ? query.orderBy(asc(invoices.issueDate))
        : query.orderBy(desc(invoices.issueDate));
    }
  } else {
    // Default sort by created_at descending
    query.orderBy(desc(invoices.createdAt));
  }

  // Apply pagination
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  query.limit(pageSize).offset(offset);

  // Execute query
  const data = await query;

  // Calculate next cursor
  const nextCursor =
    data && data.length === pageSize
      ? (offset + pageSize).toString()
      : undefined;

  return {
    meta: {
      cursor: nextCursor ?? null,
      hasPreviousPage: offset > 0,
      hasNextPage: data && data.length === pageSize,
    },
    data,
  };
}

export type GetInvoiceByIdParams = {
  id: string;
  teamId?: string;
};

export async function getInvoiceById(
  db: DatabaseOrTransaction,
  params: GetInvoiceByIdParams,
) {
  const { id, teamId } = params;

  const [result] = await db
    .select({
      id: invoices.id,
      documentSnapshot: invoices.documentSnapshot,
      dueDate: invoices.dueDate,
      invoiceNumber: invoices.invoiceNumber,
      createdAt: invoices.createdAt,
      amount: invoices.amount,
      currency: invoices.currency,
      lineItems: invoices.lineItems,
      paymentDetails: invoices.paymentDetails,
      customerDetails: invoices.customerDetails,
      reminderSentAt: invoices.reminderSentAt,
      updatedAt: invoices.updatedAt,
      note: invoices.note,
      internalNote: invoices.internalNote,
      paidAt: invoices.paidAt,
      vat: invoices.vat,
      tax: invoices.tax,
      filePath: invoices.filePath,
      status: invoices.status,
      fileSize: invoices.fileSize,
      viewedAt: invoices.viewedAt,
      fromDetails: invoices.fromDetails,
      issueDate: invoices.issueDate,
      sentAt: invoices.sentAt,
      template: invoices.template,
      templateId: invoices.templateId,
      noteDetails: invoices.noteDetails,
      customerName: invoices.customerName,
      token: invoices.token,
      sentTo: invoices.sentTo,
      discount: invoices.discount,
      subtotal: invoices.subtotal,
      topBlock: invoices.topBlock,
      bottomBlock: invoices.bottomBlock,
      scheduledAt: invoices.scheduledAt,
      scheduledJobId: invoices.scheduledJobId,
      paymentIntentId: invoices.paymentIntentId,
      refundedAt: invoices.refundedAt,
      teamId: invoices.teamId,
      customer: {
        id: customers.id,
        name: customers.name,
        website: customers.website,
        email: customers.email,
        billingEmail: customers.billingEmail,
        portalId: customers.portalId,
        portalEnabled: customers.portalEnabled,
      },
      customerId: invoices.customerId,
      team: {
        name: teams.name,
        email: teams.email,
        stripeConnected:
          sql<boolean>`${teams.stripeAccountId} IS NOT NULL AND ${teams.stripeConnectStatus} = 'connected'`.as(
            "stripe_connected",
          ),
      },
      user: {
        email: users.email,
        timezone: users.timezone,
        locale: users.locale,
      },
      // Join to get the template name and isDefault from invoice_templates
      invoiceTemplate: {
        id: invoiceTemplates.id,
        name: invoiceTemplates.name,
        isDefault: invoiceTemplates.isDefault,
      },
      // Recurring invoice data
      invoiceRecurringId: invoices.invoiceRecurringId,
      recurringSequence: invoices.recurringSequence,
      recurring: {
        id: invoiceRecurring.id,
        frequency: invoiceRecurring.frequency,
        frequencyInterval: invoiceRecurring.frequencyInterval,
        status: invoiceRecurring.status,
        nextScheduledAt: invoiceRecurring.nextScheduledAt,
        endType: invoiceRecurring.endType,
        endCount: invoiceRecurring.endCount,
        invoicesGenerated: invoiceRecurring.invoicesGenerated,
      },
    })
    .from(invoices)
    .leftJoin(
      customers,
      and(
        eq(invoices.customerId, customers.id),
        eq(customers.teamId, invoices.teamId),
      ),
    )
    .leftJoin(teams, eq(invoices.teamId, teams.id))
    .leftJoin(users, eq(invoices.userId, users.id))
    .leftJoin(invoiceTemplates, eq(invoices.templateId, invoiceTemplates.id))
    .leftJoin(
      invoiceRecurring,
      eq(invoices.invoiceRecurringId, invoiceRecurring.id),
    )
    .where(
      and(
        eq(invoices.id, id),
        // This is when we use the token to get the invoice
        teamId !== undefined ? eq(invoices.teamId, teamId) : undefined,
      ),
    );

  if (!result) {
    return null;
  }

  const template = camelcaseKeys(
    (result?.template ?? {}) as Record<string, unknown>,
    {
      deep: true,
    },
  ) as Template;

  // Populate template metadata from the joined invoice_templates table
  // This ensures correct display even for drafts saved before multi-template feature
  if (result.invoiceTemplate?.id) {
    template.id = result.invoiceTemplate.id;
    template.name = result.invoiceTemplate.name ?? "Default";
    template.isDefault = result.invoiceTemplate.isDefault ?? false;
  } else if (result.templateId) {
    // Fallback: if templateId exists but join failed, at least set the id
    template.id = result.templateId;
  }

  // Remove the invoiceTemplate from the result as it's merged into template
  const { invoiceTemplate: _, ...restResult } = result;

  return {
    ...restResult,
    template,
    lineItems: result.lineItems as LineItem[],
    paymentDetails: result.paymentDetails as EditorDoc | null,
    customerDetails: result.customerDetails as EditorDoc | null,
    fromDetails: result.fromDetails as EditorDoc | null,
    noteDetails: result.noteDetails as EditorDoc | null,
    topBlock: result.topBlock as EditorDoc | null,
    bottomBlock: result.bottomBlock as EditorDoc | null,
  };
}

/** Read-only document view; draft previews do not publish or freeze an invoice. */
export async function getInvoiceDocumentById(
  db: DatabaseOrTransaction,
  params: GetInvoiceByIdParams,
) {
  const invoice = await getInvoiceById(db, params);
  if (!invoice) return null;
  const document = applyInvoiceDocument(invoice);
  const template = camelcaseKeys(
    (document.template ?? {}) as unknown as Record<string, unknown>,
    { deep: true },
  ) as Template;
  template.paymentEnabled = invoice.template.paymentEnabled;
  return { ...document, template };
}

export async function getPublishedInvoiceById(
  db: DatabaseOrTransaction,
  params: { id: string },
) {
  const invoice = await getInvoiceDocumentById(db, params);
  if (
    !invoice ||
    !["unpaid", "overdue", "paid", "refunded"].includes(invoice.status)
  )
    return null;
  const {
    internalNote: _internalNote,
    paymentIntentId: _paymentIntentId,
    user: _user,
    scheduledJobId: _scheduledJobId,
    documentSnapshot: _documentSnapshot,
    sentTo: _sentTo,
    ...published
  } = invoice;
  return published;
}

/** Only a publishing worker calls this: capture under the same row lock as invoice edits. */
export async function prepareInvoiceDocument(
  db: DatabaseOrTransaction,
  params: GetInvoiceByIdParams & { expectedScheduledJobId?: string },
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, params.id),
          params.teamId ? eq(invoices.teamId, params.teamId) : undefined,
        ),
      )
      .for("update");
    if (!current) return null;
    if (
      params.expectedScheduledJobId !== undefined &&
      !isCurrentInvoiceSchedule(current, params.expectedScheduledJobId)
    )
      return null;
    if (!current.documentSnapshot) {
      await tx
        .update(invoices)
        .set({
          documentSnapshot: captureInvoiceDocument(current, "generation"),
        })
        .where(
          and(eq(invoices.id, current.id), eq(invoices.teamId, current.teamId)),
        );
    }
    return getInvoiceDocumentById(tx, {
      id: current.id,
      teamId: current.teamId,
    });
  });
}

/**
 * Get an invoice by its Stripe payment intent ID.
 * Used by webhooks to find invoices when processing refunds.
 */
export async function getInvoiceByPaymentIntentId(
  db: Database,
  paymentIntentId: string,
) {
  const [result] = await db
    .select({
      id: invoices.id,
      teamId: invoices.teamId,
      status: invoices.status,
      invoiceNumber: invoices.invoiceNumber,
      customerName: invoices.customerName,
      paymentIntentId: invoices.paymentIntentId,
    })
    .from(invoices)
    .where(eq(invoices.paymentIntentId, paymentIntentId))
    .limit(1);

  return result;
}

type PaymentStatusResult = {
  score: number;
  paymentStatus: string;
};

export async function getPaymentStatus(
  db: Database,
  teamId: string,
): Promise<PaymentStatusResult> {
  const invoiceData = await db.executeOnReplica(
    sql`
      SELECT 
        i.id,
        i.due_date,
        i.paid_at,
        i.status,
        i.amount,
        i.currency
      FROM invoices i
      WHERE i.team_id = ${teamId}
        AND i.due_date IS NOT NULL
        AND (
          (i.status = 'paid' AND i.paid_at IS NOT NULL) OR
          (i.status = 'unpaid' AND i.paid_at IS NULL AND i.due_date < CURRENT_DATE) OR
          (i.status = 'overdue' AND i.paid_at IS NULL AND i.due_date < CURRENT_DATE)
        )
      ORDER BY i.due_date DESC
      LIMIT 50
    `,
  );

  if (!Array.isArray(invoiceData) || invoiceData.length === 0) {
    return {
      score: 0,
      paymentStatus: "none",
    };
  }

  // Calculate weighted average days overdue (recent invoices matter more)
  let totalWeightedDays = 0;
  let totalWeight = 0;
  let onTimeCount = 0;
  let lateCount = 0;

  for (const invoice of invoiceData) {
    if (!invoice.due_date) continue;

    const dueDate = new Date(invoice.due_date as string);
    let daysOverdue = 0;

    if (invoice.status === "paid" && invoice.paid_at) {
      // For paid invoices, calculate days between due_date and paid_at
      const paidDate = new Date(invoice.paid_at as string);
      daysOverdue =
        (paidDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24);
    } else if (
      (invoice.status === "unpaid" || invoice.status === "overdue") &&
      invoice.paid_at === null
    ) {
      // For unpaid/overdue invoices, calculate days between due_date and current date
      const currentDate = new Date();
      daysOverdue =
        (currentDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24);
    }

    // Weight: recent invoices (last 90 days) get higher weight
    const daysSinceDue = Math.abs(
      (Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const weight = daysSinceDue <= 90 ? 1.5 : 1.0;

    totalWeightedDays += daysOverdue * weight;
    totalWeight += weight;

    // Track on-time vs late payments (considering 3-day grace period for banking delays)
    if (daysOverdue <= 3) {
      onTimeCount++;
    } else {
      lateCount++;
    }
  }

  const avgDaysOverdue = totalWeightedDays / totalWeight;
  const onTimeRate = onTimeCount / (onTimeCount + lateCount);

  // Calculate score based on both average days overdue and on-time rate
  let baseScore: number;

  if (avgDaysOverdue <= 3) {
    // Paid on time or within grace period
    baseScore = 100;
  } else if (avgDaysOverdue <= 7) {
    // Paid within 7 days - gradual decrease from 100 to 85
    baseScore = Math.round(100 - ((avgDaysOverdue - 3) / 4) * 15);
  } else if (avgDaysOverdue <= 14) {
    // Paid within 14 days - decrease from 85 to 65
    baseScore = Math.round(85 - ((avgDaysOverdue - 7) / 7) * 20);
  } else if (avgDaysOverdue <= 30) {
    // Paid within 30 days - decrease from 65 to 40
    baseScore = Math.round(65 - ((avgDaysOverdue - 14) / 16) * 25);
  } else {
    // Paid very late - decrease from 40 to 0
    baseScore = Math.round(Math.max(0, 40 - ((avgDaysOverdue - 30) / 30) * 40));
  }

  // Adjust score based on on-time payment rate
  const rateBonus = Math.round((onTimeRate - 0.5) * 20);
  const score = Math.max(0, Math.min(100, baseScore + rateBonus));

  // Determine payment status based on score
  let paymentStatus: string;
  if (score >= 80) {
    paymentStatus = "good";
  } else if (score >= 60) {
    paymentStatus = "average";
  } else {
    paymentStatus = "bad";
  }

  return {
    score,
    paymentStatus,
  };
}

type SearchInvoiceNumberParams = {
  teamId: string;
  query: string;
};

export async function searchInvoiceNumber(
  db: Database,
  params: SearchInvoiceNumberParams,
) {
  const [result] = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.teamId, params.teamId),
        ilike(invoices.invoiceNumber, `%${params.query}`),
      ),
    )
    .limit(1);

  return result ?? null;
}

/**
 * Generate the next invoice number for a team.
 * Format: INV-XXXX (e.g., INV-0001, INV-0042)
 *
 * Logic:
 * 1. Find the highest numeric suffix from existing invoice numbers
 * 2. If found, increment by 1
 * 3. If not found, count total invoices + 1
 * 4. Pad to 4 digits with leading zeros
 */
export async function getNextInvoiceNumber(
  db: DatabaseOrTransaction,
  teamId: string,
): Promise<string> {
  // PostgreSQL serializes conflicts on the team's counter. Numeric avoids int32
  // overflow for existing/custom suffixes; no JS number conversion loses digits.
  // Extremely long custom identifiers do not exhaust the 120-character display namespace.
  const result = await db.execute<{ value: string }>(sql`
    INSERT INTO public.invoice_number_counters (team_id, last_number)
    SELECT ${teamId}::uuid, COALESCE(MAX(SUBSTRING(btrim(invoice_number) FROM '[0-9]+$')::numeric), 0) + 1
    FROM public.invoices WHERE team_id = ${teamId}::uuid AND btrim(invoice_number) ~ '[0-9]+$'
      AND length(SUBSTRING(btrim(invoice_number) FROM '[0-9]+$')) <= 100
    ON CONFLICT (team_id) DO UPDATE SET last_number =
      GREATEST(public.invoice_number_counters.last_number, EXCLUDED.last_number - 1) + 1
    RETURNING last_number::text AS value
  `);
  const value = result.rows[0]?.value;
  if (!value) throw new Error("Failed to allocate invoice number");
  return `INV-${value.padStart(4, "0")}`;
}

export async function isInvoiceNumberUsed(
  db: Database,
  teamId: string,
  invoiceNumber: string,
): Promise<boolean> {
  const [result] = await db
    .select({
      id: invoices.id,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.teamId, teamId),
        eq(invoices.invoiceNumber, invoiceNumber),
      ),
    )
    .limit(1);

  return !!result;
}

type DraftInvoiceLineItemParams = {
  name?: string | null; // Stringified TipTap JSONContent
  quantity?: number;
  unit?: string | null;
  price?: number;
  vat?: number | null;
  tax?: number | null;
  taxRate?: number | null;
};

type DraftInvoiceTemplateParams = {
  customerLabel?: string;
  title?: string;
  fromLabel?: string;
  invoiceNoLabel?: string;
  issueDateLabel?: string;
  dueDateLabel?: string;
  descriptionLabel?: string;
  priceLabel?: string;
  quantityLabel?: string;
  totalLabel?: string;
  totalSummaryLabel?: string;
  vatLabel?: string;
  subtotalLabel?: string;
  taxLabel?: string;
  discountLabel?: string;
  sendCopy?: boolean;
  timezone?: string;
  paymentLabel?: string;
  noteLabel?: string;
  logoUrl?: string | null;
  currency?: string;
  paymentDetails?: string | null;
  fromDetails?: string | null;
  dateFormat?: string;
  includeVat?: boolean;
  includeTax?: boolean;
  includeLineItemTax?: boolean;
  lineItemTaxLabel?: string;
  includeDiscount?: boolean;
  includeDecimals?: boolean;
  includeUnits?: boolean;
  includeQr?: boolean;
  taxRate?: number | null;
  vatRate?: number | null;
  size?: "a4" | "letter";
  deliveryType?: "create" | "create_and_send" | "scheduled";
  locale?: string;
};

type DraftInvoiceParams = {
  id: string;
  template: DraftInvoiceTemplateParams;
  templateId?: string | null;
  fromDetails?: string | null;
  customerDetails?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  paymentDetails?: string | null;
  noteDetails?: string | null;
  dueDate: string;
  issueDate: string;
  invoiceNumber: string;
  logoUrl?: string | null;
  vat?: number | null;
  tax?: number | null;
  discount?: number | null;
  subtotal?: number | null;
  topBlock?: string | null;
  bottomBlock?: string | null;
  amount?: number | null;
  lineItems?: DraftInvoiceLineItemParams[];
  token?: string;
  teamId: string;
  userId: string | null;
};

export async function draftInvoice(
  db: DatabaseOrTransaction,
  params: DraftInvoiceParams,
) {
  const {
    id,
    teamId,
    userId,
    token,
    template,
    templateId,
    paymentDetails,
    fromDetails,
    customerDetails,
    noteDetails,
    ...restInput
  } = params;

  validateInvoiceMoney({ ...restInput, template });
  restInput.invoiceNumber = restInput.invoiceNumber.trim();
  if (
    !restInput.invoiceNumber ||
    restInput.invoiceNumber.length > 120 ||
    Array.from(restInput.invoiceNumber).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  ) {
    throw new InvoiceAmountError(
      "Invoice number must be 1-120 characters without control characters",
    );
  }
  const useToken = token ?? (await generateToken(id));

  const { paymentDetails: _, fromDetails: __, ...restTemplate } = template;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-number/${teamId}`}, 0))`,
    );
    const [sameNumber] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.teamId, teamId),
          sql`btrim(${invoices.invoiceNumber}) = ${restInput.invoiceNumber}`,
        ),
      )
      .limit(1);
    if (sameNumber && sameNumber.id !== id)
      throw new InvoiceAmountError(
        "Invoice number is already used by another invoice",
      );
    await assertTeamOwnership(tx, teamId, "customers", [restInput.customerId]);
    await assertTeamOwnership(tx, teamId, "invoiceTemplates", [templateId]);

    // Lock before inspecting payment state. A webhook/payment update cannot
    // finalize this row between validation and the financial write. Token
    // generation and all external work stay outside this short transaction.
    const [existing] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.teamId, teamId)))
      .for("update");
    const mergedTemplate = getInvoiceMoneyTemplate({
      ...(existing?.template as DraftInvoiceTemplateParams | null),
      ...Object.fromEntries(
        Object.entries(restTemplate).filter(([, value]) => value !== undefined),
      ),
    }) as DraftInvoiceTemplateParams;
    const currency = (
      template.currency ??
      existing?.currency ??
      mergedTemplate.currency
    )?.toUpperCase();
    if (currency !== undefined) mergedTemplate.currency = currency;

    const financialChanges = existing
      ? hasInvoiceFinancialChanges(
          {
            ...existing,
            lineItems: existing.lineItems as
              | DraftInvoiceLineItemParams[]
              | null,
            template: {
              ...(existing.template as DraftInvoiceTemplateParams | null),
              currency: existing.currency,
            },
          },
          { ...restInput, template: restTemplate },
        )
      : true;
    const [paymentReservation] = existing
      ? await tx
          .select({ id: invoicePaymentReservations.id })
          .from(invoicePaymentReservations)
          .where(eq(invoicePaymentReservations.invoiceId, id))
          .limit(1)
      : [];
    const financialLock =
      existing &&
      (Boolean(existing.documentSnapshot) ||
        ["unpaid", "overdue"].includes(existing.status) ||
        paymentReservation !== undefined ||
        existing.paymentIntentId !== null ||
        existing.paidAt !== null ||
        existing.refundedAt !== null ||
        ["paid", "refunded", "canceled"].includes(existing.status));
    if (
      (financialLock && financialChanges) ||
      (existing &&
        (existing.status !== "draft" ||
          Boolean(existing.documentSnapshot) ||
          financialLock) &&
        hasInvoiceIdentityChanges(existing, {
          ...restInput,
          customerDetails,
          fromDetails,
        }))
    ) {
      throw new InvoiceFinancialStateError(
        "Issued invoice is immutable. Duplicate it to create a corrected invoice.",
      );
    }

    // Never recalculate an existing issued snapshot merely because its notes or
    // due date were saved. Editable drafts and explicit financial edits use the
    // same server calculation for REST, tRPC, MCP, duplicates and recurring jobs.
    const amounts =
      existing &&
      (financialLock || (existing.status !== "draft" && !financialChanges))
        ? {
            amount: existing.amount,
            subtotal: existing.subtotal,
            vat: existing.vat,
            tax: existing.tax,
            discount: existing.discount,
          }
        : calculateInvoiceAmounts({
            template: mergedTemplate,
            lineItems:
              restInput.lineItems ??
              (existing?.lineItems as DraftInvoiceLineItemParams[] | null),
            amount:
              restInput.amount === undefined
                ? existing?.amount
                : restInput.amount,
            subtotal:
              restInput.subtotal === undefined
                ? existing?.subtotal
                : restInput.subtotal,
            vat: restInput.vat === undefined ? existing?.vat : restInput.vat,
            tax: restInput.tax === undefined ? existing?.tax : restInput.tax,
            discount:
              restInput.discount === undefined
                ? existing?.discount
                : restInput.discount,
          });
    const values = {
      userId,
      token:
        existing && (existing.documentSnapshot || existing.status !== "draft")
          ? existing.token
          : useToken,
      templateId,
      ...restInput,
      ...amounts,
      currency,
      template: camelcaseKeys(mergedTemplate, { deep: true }),
      paymentDetails,
      fromDetails,
      customerDetails,
      noteDetails,
    };

    if (existing) {
      const [result] = await tx
        .update(invoices)
        .set({
          ...values,
          documentSnapshot:
            existing.documentSnapshot ??
            (financialLock
              ? captureInvoiceDocument(existing, "legacy_current")
              : null),
          // Preserve the existing overdue -> unpaid due-date correction contract.
          status: sql`CASE
          WHEN ${invoices.status} = 'overdue' AND ${restInput.dueDate}::timestamp >= now()
          THEN 'unpaid'
          ELSE ${invoices.status}
        END`,
        })
        .where(and(eq(invoices.id, id), eq(invoices.teamId, teamId)))
        .returning();
      if (!result) throw new TenantResourceNotFoundError();
      return result;
    }

    const [result] = await tx
      .insert(invoices)
      .values({ id, teamId, ...values })
      // A concurrent insert must not become an unvalidated update, especially
      // if that invoice has already entered payment or belongs to another team.
      .onConflictDoNothing({ target: invoices.id })
      .returning();

    if (!result) {
      const [concurrent] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.id, id), eq(invoices.teamId, teamId)));
      if (concurrent)
        throw new InvoiceFinancialStateError(
          "Invoice was created concurrently; reload it before saving again",
        );
      throw new TenantResourceNotFoundError();
    }

    return result;
  });
}

export type GetInvoiceSummaryParams = {
  teamId: string;
  statuses?: (
    | "paid"
    | "canceled"
    | "overdue"
    | "unpaid"
    | "draft"
    | "scheduled"
  )[];
};

export async function getInvoiceSummary(
  db: Database,
  params: GetInvoiceSummaryParams,
) {
  const { teamId, statuses } = params;

  const whereConditions: SQL[] = [eq(invoices.teamId, teamId)];

  if (statuses && statuses.length > 0) {
    whereConditions.push(inArray(invoices.status, statuses));
  }

  const [[team], currencyTotals] = await Promise.all([
    db
      .select({ baseCurrency: teams.baseCurrency })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1),
    db
      .select({
        currency: invoices.currency,
        totalAmount: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} IN ('unpaid','overdue') THEN ${invoiceOutstandingAmount} WHEN ${invoices.status}='paid' THEN ${invoiceReceivedAmount} ELSE ${invoices.amount} END), 0)`,
        invoiceCount: count(),
      })
      .from(invoices)
      .where(and(...whereConditions))
      .groupBy(invoices.currency),
  ]);

  const baseCurrency = team?.baseCurrency || "USD";

  if (currencyTotals.length === 0) {
    return {
      totalAmount: 0,
      invoiceCount: 0,
      currency: baseCurrency,
    };
  }

  const foreignCurrencies = currencyTotals
    .map((row) => row.currency || baseCurrency)
    .filter((c) => c !== baseCurrency);

  const rateMap = new Map<string, number>();
  if (foreignCurrencies.length > 0) {
    const pairs = foreignCurrencies.map((c) => ({
      base: c,
      target: baseCurrency,
    }));
    const batchRates = await getExchangeRatesBatch(db, { pairs });
    for (const [key, rate] of batchRates) {
      const base = key.split(":")[0];
      if (base) rateMap.set(base, rate);
    }
  }

  let totalAmount = 0;
  let invoiceCount = 0;
  const breakdown: Array<{
    currency: string;
    originalAmount: number;
    convertedAmount: number;
    count: number;
  }> = [];

  for (const row of currencyTotals) {
    const currency = row.currency || baseCurrency;
    const amount = Number(row.totalAmount) || 0;
    const rowCount = Number(row.invoiceCount) || 0;

    if (currency === baseCurrency) {
      totalAmount += amount;
      breakdown.push({
        currency,
        originalAmount: Math.round(amount * 100) / 100,
        convertedAmount: Math.round(amount * 100) / 100,
        count: rowCount,
      });
      invoiceCount += rowCount;
    } else {
      const rate = rateMap.get(currency);
      if (rate) {
        const convertedAmount = amount * rate;
        totalAmount += convertedAmount;
        breakdown.push({
          currency,
          originalAmount: Math.round(amount * 100) / 100,
          convertedAmount: Math.round(convertedAmount * 100) / 100,
          count: rowCount,
        });
        invoiceCount += rowCount;
      }
      if (!rate || rate <= 0)
        throw new InvoiceAmountError(
          "A complete invoice total requires current exchange rates for every currency",
        );
    }
  }

  breakdown.sort((a, b) => b.originalAmount - a.originalAmount);

  return {
    totalAmount: Math.round(totalAmount * 100) / 100,
    invoiceCount,
    currency: baseCurrency,
    breakdown: breakdown.length > 1 ? breakdown : undefined,
  };
}

export type DeleteInvoiceParams = {
  id: string;
  teamId: string;
};

export async function deleteInvoice(
  db: DatabaseOrTransaction,
  params: DeleteInvoiceParams,
) {
  const { id, teamId } = params;
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.teamId, teamId)))
      .for("update");
    if (!invoice || !["draft", "canceled"].includes(invoice.status))
      return undefined;
    const [reservation] = await tx
      .select({ id: invoicePaymentReservations.id })
      .from(invoicePaymentReservations)
      .where(eq(invoicePaymentReservations.invoiceId, id))
      .limit(1);
    if (
      invoice.documentSnapshot ||
      invoice.paymentIntentId ||
      invoice.paidAt ||
      invoice.refundedAt ||
      reservation
    ) {
      throw new InvoiceFinancialStateError(
        "Issued invoices and invoices with payment history or a reserved payment cannot be deleted",
      );
    }
    await releaseDraftTrackerAllocations(tx, { invoiceId: id, teamId });
    const [result] = await tx
      .delete(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.teamId, teamId)))
      .returning({ id: invoices.id });
    return result;
  });
}

export type DuplicateInvoiceParams = {
  id: string;
  userId: string;
  invoiceNumber: string;
  teamId: string;
};

export async function duplicateInvoice(
  db: Database,
  params: DuplicateInvoiceParams,
) {
  const { id, userId, invoiceNumber, teamId } = params;

  // 1. Fetch the invoice that needs to be duplicated
  const [invoice] = await db
    .select({
      teamId: invoices.teamId,
      template: invoices.template,
      customerId: invoices.customerId,
      customerName: invoices.customerName,
      vat: invoices.vat,
      tax: invoices.tax,
      discount: invoices.discount,
      subtotal: invoices.subtotal,
      amount: invoices.amount,
      paymentDetails: invoices.paymentDetails,
      noteDetails: invoices.noteDetails,
      topBlock: invoices.topBlock,
      bottomBlock: invoices.bottomBlock,
      fromDetails: invoices.fromDetails,
      customerDetails: invoices.customerDetails,
      lineItems: invoices.lineItems,
    })
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.teamId, teamId)));

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  const draftId = uuidv4();
  const token = await generateToken(draftId);

  const result = await draftInvoice(db, {
    id: draftId,
    token,
    userId,
    teamId: invoice.teamId,
    template: invoice.template as DraftInvoiceTemplateParams,
    dueDate: addMonths(new Date(), 1).toISOString(),
    issueDate: new Date().toISOString(),
    invoiceNumber,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    vat: invoice.vat,
    tax: invoice.tax,
    discount: invoice.discount,
    subtotal: invoice.subtotal,
    amount: invoice.amount,

    // @ts-expect-error - JSONB
    paymentDetails: invoice.paymentDetails,
    // @ts-expect-error - JSONB
    noteDetails: invoice.noteDetails,
    // @ts-expect-error - JSONB
    topBlock: invoice.topBlock,
    // @ts-expect-error - JSONB
    bottomBlock: invoice.bottomBlock,
    // @ts-expect-error - JSONB
    fromDetails: invoice.fromDetails,
    // @ts-expect-error - JSONB
    customerDetails: invoice.customerDetails,
    // @ts-expect-error - JSONB
    lineItems: invoice.lineItems,
  });

  logActivity({
    db,
    teamId,
    userId,
    type: "invoice_duplicated",
    metadata: {
      originalInvoiceId: id,
      newInvoiceId: result?.id,
      newInvoiceNumber: result?.invoiceNumber,
    },
  });

  return result;
}

export type UpdateInvoiceParams = {
  id: string;
  status?: "paid" | "canceled" | "unpaid" | "scheduled" | "draft" | "refunded";
  paidAt?: string | null;
  internalNote?: string | null;
  reminderSentAt?: string | null;
  scheduledAt?: string | null;
  scheduledJobId?: string | null;
  paymentIntentId?: string | null;
  refundedAt?: string | null;
  sentTo?: string | null;
  sentAt?: string | null;
  filePath?: string[] | null;
  fileSize?: number | null;
  invoiceRecurringId?: string | null;
  recurringSequence?: number | null;
  teamId: string;
  userId?: string;
};

export async function updateInvoice(
  db: DatabaseOrTransaction,
  params: UpdateInvoiceParams,
) {
  const { id, teamId, userId, ...rest } = params;

  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.teamId, teamId)))
      .for("update");
    if (!current) return undefined;
    if (
      rest.status &&
      rest.status !== current.status &&
      ((["paid", "refunded", "canceled"].includes(current.status) &&
        !(current.status === "paid" && rest.status === "refunded")) ||
        ((current.paidAt || current.refundedAt) &&
          !["paid", "refunded"].includes(rest.status)) ||
        (rest.status === "refunded" && current.status !== "paid"))
    ) {
      throw new InvoiceFinancialStateError(
        "Finalized invoice status cannot be reopened; create a correction invoice instead",
      );
    }
    if (
      (current.paidAt && rest.paidAt === null) ||
      (current.refundedAt && rest.refundedAt === null) ||
      (current.paymentIntentId &&
        rest.paymentIntentId !== undefined &&
        rest.paymentIntentId !== current.paymentIntentId)
    ) {
      throw new InvoiceFinancialStateError(
        "Payment history cannot be cleared or replaced",
      );
    }
    const [updated] = await tx
      .update(invoices)
      .set({
        ...rest,
        documentSnapshot:
          current.documentSnapshot ??
          (["unpaid", "overdue", "paid", "refunded"].includes(
            rest.status ?? current.status,
          )
            ? captureInvoiceDocument(current, "issued")
            : null),
      })
      .where(and(eq(invoices.id, id), eq(invoices.teamId, teamId)))
      .returning();
    return updated;
  });

  // Log activity if not draft
  if (result && rest.status !== "draft" && userId) {
    let priority: number | undefined;
    let activityType: (typeof activityTypeEnum.enumValues)[number] | null =
      null;

    if (rest.status === "paid") {
      activityType = "invoice_paid";
      priority = 3;
    } else if (rest.status === "canceled") {
      activityType = "invoice_cancelled";
      priority = 3;
    }

    if (activityType) {
      logActivity({
        db,
        teamId,
        userId,
        type: activityType,
        priority,
        metadata: {
          recordId: id,
          invoiceNumber: result?.invoiceNumber,
          customerName: result?.customerName,
          newStatus: rest.status,
          paidAt: rest.paidAt,
        },
      });
    }
  }

  return result;
}

export type GetMostActiveClientParams = {
  teamId: string;
};

export async function getMostActiveClient(
  db: Database,
  params: GetMostActiveClientParams,
) {
  const { teamId } = params;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Aggregate independent one-to-many relations before joining them. Otherwise
  // each tracker entry is counted once per invoice of the same customer.
  const invoiceTotals = db
    .select({
      customerId: invoices.customerId,
      count: sql<number>`COUNT(*)::int`.as("invoice_count"),
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.teamId, teamId),
        gte(invoices.createdAt, thirtyDaysAgo.toISOString()),
      ),
    )
    .groupBy(invoices.customerId)
    .as("invoice_totals");
  const trackerTotals = db
    .select({
      customerId: trackerProjects.customerId,
      duration:
        sql<number>`COALESCE(SUM(${trackerEntries.duration}), 0)::bigint`.as(
          "tracker_duration",
        ),
    })
    .from(trackerEntries)
    .innerJoin(
      trackerProjects,
      and(
        eq(trackerEntries.projectId, trackerProjects.id),
        eq(trackerProjects.teamId, teamId),
      ),
    )
    .where(
      and(
        eq(trackerEntries.teamId, teamId),
        gte(
          trackerEntries.date,
          thirtyDaysAgo.toISOString().split("T")[0] ?? "",
        ),
      ),
    )
    .groupBy(trackerProjects.customerId)
    .as("tracker_totals");
  const result = await db
    .select({
      customerId: customers.id,
      customerName: customers.name,
      invoiceCount: sql<number>`COALESCE(${invoiceTotals.count}, 0)::int`,
      totalTrackerTime: sql<number>`COALESCE(${trackerTotals.duration}, 0)::int`,
    })
    .from(customers)
    .leftJoin(invoiceTotals, eq(invoiceTotals.customerId, customers.id))
    .leftJoin(trackerTotals, eq(trackerTotals.customerId, customers.id))
    .where(
      and(
        eq(customers.teamId, teamId),
        sql`COALESCE(${invoiceTotals.count},0)>0 OR COALESCE(${trackerTotals.duration},0)>0`,
      ),
    )
    .orderBy(
      sql`(COALESCE(${invoiceTotals.count},0) + COALESCE(${trackerTotals.duration},0) / 3600) DESC`,
      asc(customers.id),
    )
    .limit(1);

  return result[0] || null;
}

export type GetInactiveClientsCountParams = {
  teamId: string;
};

export async function getInactiveClientsCount(
  db: Database,
  params: GetInactiveClientsCountParams,
) {
  const { teamId } = params;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Use a subquery to properly count inactive clients
  const [result] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(
      db
        .select({
          customerId: customers.id,
        })
        .from(customers)
        .leftJoin(
          invoices,
          and(
            eq(invoices.customerId, customers.id),
            gte(invoices.createdAt, thirtyDaysAgo.toISOString()),
          ),
        )
        .leftJoin(trackerProjects, eq(trackerProjects.customerId, customers.id))
        .leftJoin(
          trackerEntries,
          and(
            eq(trackerEntries.projectId, trackerProjects.id),
            gte(
              trackerEntries.date,
              thirtyDaysAgo.toISOString().split("T")[0] ?? "",
            ),
          ),
        )
        .where(
          and(
            eq(customers.teamId, teamId),
            lt(customers.createdAt, thirtyDaysAgo.toISOString()),
          ),
        )
        .groupBy(customers.id)
        .having(
          sql`COUNT(DISTINCT ${invoices.id}) = 0 AND COALESCE(SUM(${trackerEntries.duration}), 0) = 0`,
        )
        .as("inactive_customers"),
    );

  return result?.count || 0;
}

export type GetAverageDaysToPaymentParams = {
  teamId: string;
};

export async function getAverageDaysToPayment(
  db: Database,
  params: GetAverageDaysToPaymentParams,
) {
  const { teamId } = params;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [result] = await db
    .select({
      averageDays: sql<number>`ROUND(AVG(DATE_PART('day', ${invoices.paidAt}::timestamp - ${invoices.sentAt}::timestamp)))::int`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.teamId, teamId),
        eq(invoices.status, "paid"),
        isNotNull(invoices.paidAt),
        isNotNull(invoices.sentAt),
        gte(invoices.paidAt, thirtyDaysAgo.toISOString()),
      ),
    );

  return result?.averageDays || 0;
}

export type GetAverageInvoiceSizeParams = {
  teamId: string;
};

export async function getAverageInvoiceSize(
  db: Database,
  params: GetAverageInvoiceSizeParams,
) {
  const { teamId } = params;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const result = await db
    .select({
      currency: invoices.currency,
      averageAmount: sql<number>`ROUND(AVG(${invoices.amount}), 2)::float`,
      invoiceCount: sql<number>`COUNT(*)::int`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.teamId, teamId),
        gte(invoices.sentAt, thirtyDaysAgo.toISOString()),
        isNotNull(invoices.sentAt),
      ),
    )
    .groupBy(invoices.currency);

  return result;
}

export type GetInvoicePaymentAnalysisParams = {
  teamId: string;
  from: string;
  to: string;
  currency?: string;
};

export type InvoicePaymentAnalysisResult = {
  metrics: {
    averageDaysToPay: number;
    paymentRate: number;
    overdueRate: number;
    paymentScore: number;
    totalInvoices: number;
    paidInvoices: number;
    unpaidInvoices: number;
    overdueInvoices: number;
    overdueAmount: number;
  };
  paymentTrends: Array<{
    month: string;
    averageDaysToPay: number;
    paymentRate: number;
    invoiceCount: number;
  }>;
  overdueSummary: {
    count: number;
    totalAmount: number;
    oldestDays: number;
  };
};

export async function getInvoicePaymentAnalysis(
  db: Database,
  params: GetInvoicePaymentAnalysisParams,
): Promise<InvoicePaymentAnalysisResult> {
  const { teamId, from, to, currency: inputCurrency } = params;

  const fromDate = startOfMonth(new UTCDate(parseISO(from)));
  const toDate = endOfMonth(new UTCDate(parseISO(to)));

  // Get team's base currency
  const [team] = await db
    .select({ baseCurrency: teams.baseCurrency })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);

  const targetCurrency = inputCurrency || team?.baseCurrency || "USD";

  // Build base conditions
  const baseConditions = [
    eq(invoices.teamId, teamId),
    gte(invoices.createdAt, format(fromDate, "yyyy-MM-dd")),
    lte(invoices.createdAt, format(toDate, "yyyy-MM-dd")),
  ];

  if (inputCurrency) {
    baseConditions.push(eq(invoices.currency, inputCurrency));
  }

  // Get all invoices in date range
  const allInvoices = await db
    .select({
      id: invoices.id,
      amount: invoices.amount,
      currency: invoices.currency,
      status: invoices.status,
      dueDate: invoices.dueDate,
      paidAt: invoices.paidAt,
      createdAt: invoices.createdAt,
      issueDate: invoices.issueDate,
    })
    .from(invoices)
    .where(and(...baseConditions));

  if (allInvoices.length === 0) {
    return {
      metrics: {
        averageDaysToPay: 0,
        paymentRate: 0,
        overdueRate: 0,
        paymentScore: 0,
        totalInvoices: 0,
        paidInvoices: 0,
        unpaidInvoices: 0,
        overdueInvoices: 0,
        overdueAmount: 0,
      },
      paymentTrends: [],
      overdueSummary: {
        count: 0,
        totalAmount: 0,
        oldestDays: 0,
      },
    };
  }

  // Calculate metrics
  const paidInvoices = allInvoices.filter((inv) => inv.status === "paid");
  const unpaidInvoices = allInvoices.filter(
    (inv) => inv.status === "unpaid" || inv.status === "overdue",
  );
  const overdueInvoices = allInvoices.filter(
    (inv) =>
      (inv.status === "overdue" ||
        (inv.status === "unpaid" &&
          inv.dueDate &&
          parseISO(inv.dueDate) < new Date())) &&
      !inv.paidAt,
  );

  // Calculate average days to pay (from issue date or created date to paid date)
  let totalDaysToPay = 0;
  let paidCount = 0;

  for (const invoice of paidInvoices) {
    if (invoice.paidAt) {
      const issueDate =
        invoice.issueDate || invoice.createdAt || invoice.dueDate;
      if (issueDate) {
        const daysToPay =
          (new Date(invoice.paidAt).getTime() - parseISO(issueDate).getTime()) /
          (1000 * 60 * 60 * 24);
        if (daysToPay >= 0) {
          totalDaysToPay += daysToPay;
          paidCount++;
        }
      }
    }
  }

  const averageDaysToPay =
    paidCount > 0 ? Math.round(totalDaysToPay / paidCount) : 0;

  // Calculate payment rate
  const paymentRate =
    allInvoices.length > 0
      ? Math.round((paidInvoices.length / allInvoices.length) * 100)
      : 0;

  // Calculate overdue rate
  const overdueRate =
    allInvoices.length > 0
      ? Math.round((overdueInvoices.length / allInvoices.length) * 100)
      : 0;

  // Calculate overdue amount (convert to target currency)
  let overdueAmount = 0;
  for (const invoice of overdueInvoices) {
    const amount = Number(invoice.amount) || 0;
    if (invoice.currency === targetCurrency) {
      overdueAmount += amount;
    } else {
      // For simplicity, use amount as-is (could add currency conversion)
      overdueAmount += amount;
    }
  }

  // Calculate payment score (similar to getPaymentStatus logic)
  let paymentScore = 100;
  if (averageDaysToPay > 30) {
    paymentScore = Math.max(0, 100 - (averageDaysToPay - 30) * 2);
  } else if (averageDaysToPay > 14) {
    paymentScore = 85 - ((averageDaysToPay - 14) / 16) * 25;
  } else if (averageDaysToPay > 7) {
    paymentScore = 100 - ((averageDaysToPay - 7) / 7) * 15;
  }

  // Adjust score based on overdue rate
  paymentScore = Math.max(0, Math.min(100, paymentScore - overdueRate * 0.5));

  // Calculate payment trends by month
  const monthSeries = eachMonthOfInterval({ start: fromDate, end: toDate });
  const paymentTrends = monthSeries.map((monthStart) => {
    const monthEnd = endOfMonth(monthStart);
    const monthStr = format(monthStart, "yyyy-MM");

    const monthInvoices = allInvoices.filter((inv) => {
      const invDate = inv.createdAt || inv.issueDate;
      if (!invDate) return false;
      const invDateObj = parseISO(invDate);
      return invDateObj >= monthStart && invDateObj <= monthEnd;
    });

    const monthPaid = monthInvoices.filter((inv) => inv.status === "paid");
    let monthTotalDays = 0;
    let monthPaidCount = 0;

    for (const invoice of monthPaid) {
      if (invoice.paidAt) {
        const issueDate =
          invoice.issueDate || invoice.createdAt || invoice.dueDate;
        if (issueDate) {
          const daysToPay =
            (new Date(invoice.paidAt).getTime() -
              parseISO(issueDate).getTime()) /
            (1000 * 60 * 60 * 24);
          if (daysToPay >= 0) {
            monthTotalDays += daysToPay;
            monthPaidCount++;
          }
        }
      }
    }

    const monthAvgDays =
      monthPaidCount > 0 ? Math.round(monthTotalDays / monthPaidCount) : 0;
    const monthPaymentRate =
      monthInvoices.length > 0
        ? Math.round((monthPaid.length / monthInvoices.length) * 100)
        : 0;

    return {
      month: monthStr,
      averageDaysToPay: monthAvgDays,
      paymentRate: monthPaymentRate,
      invoiceCount: monthInvoices.length,
    };
  });

  // Calculate overdue summary
  let oldestDays = 0;
  const now = new Date();
  for (const invoice of overdueInvoices) {
    if (invoice.dueDate) {
      const daysOverdue =
        (now.getTime() - parseISO(invoice.dueDate).getTime()) /
        (1000 * 60 * 60 * 24);
      oldestDays = Math.max(oldestDays, Math.round(daysOverdue));
    }
  }

  return {
    metrics: {
      averageDaysToPay,
      paymentRate,
      overdueRate,
      paymentScore: Math.round(paymentScore),
      totalInvoices: allInvoices.length,
      paidInvoices: paidInvoices.length,
      unpaidInvoices: unpaidInvoices.length,
      overdueInvoices: overdueInvoices.length,
      overdueAmount: Math.round(overdueAmount * 100) / 100,
    },
    paymentTrends,
    overdueSummary: {
      count: overdueInvoices.length,
      totalAmount: Math.round(overdueAmount * 100) / 100,
      oldestDays,
    },
  };
}
