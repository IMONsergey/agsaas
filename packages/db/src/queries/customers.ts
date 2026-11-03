import { buildSearchQuery } from "@midday/db/utils/search-query";
import { generateToken } from "@midday/invoice/token";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm/sql/sql";
import {
  invoiceReceivedAmount,
  invoiceOutstandingAmount,
} from "../invoice-settlement-sql";
import { nanoid } from "nanoid";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  customers,
  customerTags,
  exchangeRates,
  invoices,
  tags,
  teams,
  trackerProjects,
} from "../schema";
import {
  assertTeamOwnership,
  TenantResourceNotFoundError,
} from "../utils/tenant-ownership";
import { createActivity } from "./activities";
import { getExchangeRatesBatch } from "./exhange-rates";

// Aggregate independent one-to-many relations before joining them to customers.
// Joining invoices, projects and tags first multiplies both counts and money.
function customerRelationTotals(db: DatabaseOrTransaction, teamId: string) {
  const projectTotals = db
    .select({
      customerId: trackerProjects.customerId,
      count: sql<number>`count(*)::int`.as("project_count"),
    })
    .from(trackerProjects)
    .where(eq(trackerProjects.teamId, teamId))
    .groupBy(trackerProjects.customerId)
    .as("customer_project_totals");

  const tagTotals = db
    .select({
      customerId: customerTags.customerId,
      tags: sql<CustomerTag[]>`json_agg(distinct jsonb_build_object(
        'id', ${tags.id}, 'name', ${tags.name}
      ))`.as("customer_tags"),
      firstName: sql<string>`min(${tags.name})`.as("first_tag_name"),
    })
    .from(customerTags)
    .innerJoin(
      tags,
      and(eq(tags.id, customerTags.tagId), eq(tags.teamId, teamId)),
    )
    .where(eq(customerTags.teamId, teamId))
    .groupBy(customerTags.customerId)
    .as("customer_tag_totals");

  return { projectTotals, tagTotals };
}

function customerInvoiceTotals(db: DatabaseOrTransaction, teamId: string) {
  // Existing teams may not have a base currency. Only a single team-wide source
  // currency is a defensible fallback: both displayed totals and sorting must
  // use the same unit across customers, never mixed raw amounts labeled as USD.
  const sourceCurrencies = db
    .select({
      currency: sql<
        string | null
      >`CASE WHEN count(distinct ${invoices.currency}) = 1
        THEN min(${invoices.currency}) END`.as("source_currency"),
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.teamId, teamId),
        inArray(invoices.status, ["paid", "unpaid", "overdue"]),
        sql`${invoices.currency} ~ '^[A-Z]{3}$'`,
      ),
    )
    .as("customer_invoice_currencies");

  const reportingCurrency = sql<string | null>`CASE
    WHEN ${teams.baseCurrency} ~ '^[A-Z]{3}$' THEN ${teams.baseCurrency}
    ELSE ${sourceCurrencies.currency} END`;

  const invoiceAmounts = db
    .select({
      customerId: invoices.customerId,
      status: invoices.status,
      issueDate: invoices.issueDate,
      currency: reportingCurrency.as("reporting_currency"),
      paidAmount: sql<number | null>`CASE WHEN ${invoiceReceivedAmount}=0 THEN 0
        WHEN ${invoices.currency} ~ '^[A-Z]{3}$' THEN CASE WHEN ${invoices.currency}=${reportingCurrency}
          THEN ${invoiceReceivedAmount} ELSE ${invoiceReceivedAmount}*${exchangeRates.rate} END END`.as(
        "received_amount",
      ),
      outstandingAmount: sql<
        number | null
      >`CASE WHEN ${invoiceOutstandingAmount}=0 THEN 0
        WHEN ${invoices.currency} ~ '^[A-Z]{3}$' THEN CASE WHEN ${invoices.currency}=${reportingCurrency}
          THEN ${invoiceOutstandingAmount} ELSE ${invoiceOutstandingAmount}*${exchangeRates.rate} END END`.as(
        "outstanding_amount",
      ),
    })
    .from(invoices)
    .innerJoin(teams, eq(teams.id, invoices.teamId))
    .leftJoin(sourceCurrencies, sql`true`)
    .leftJoin(
      exchangeRates,
      and(
        eq(exchangeRates.base, invoices.currency),
        eq(exchangeRates.target, reportingCurrency),
        sql`${exchangeRates.rate} > 0`,
      ),
    )
    .where(eq(invoices.teamId, teamId))
    .as("customer_invoice_amounts");

  return db
    .select({
      customerId: invoiceAmounts.customerId,
      count: sql<number>`count(*)::int`.as("invoice_count"),
      // Completeness is independent for paid and outstanding totals. A missing
      // FX rate must not be disguised as a zero or a plausible partial total.
      totalRevenue: sql<
        number | null
      >`CASE WHEN count(*) FILTER (WHERE ${invoiceAmounts.paidAmount} IS NULL)>0 THEN NULL
        ELSE round(coalesce(sum(${invoiceAmounts.paidAmount}),0),2)::float END`.as(
        "total_revenue",
      ),
      outstandingAmount: sql<
        number | null
      >`CASE WHEN count(*) FILTER (WHERE ${invoiceAmounts.outstandingAmount} IS NULL)>0 THEN NULL
        ELSE round(coalesce(sum(${invoiceAmounts.outstandingAmount}),0),2)::float END`.as(
        "outstanding_amount",
      ),
      lastInvoiceDate: sql<string | null>`max(${invoiceAmounts.issueDate})`.as(
        "last_invoice_date",
      ),
      currency: sql<string | null>`max(${invoiceAmounts.currency})`.as(
        "invoice_currency",
      ),
    })
    .from(invoiceAmounts)
    .groupBy(invoiceAmounts.customerId)
    .as("customer_invoice_totals");
}

type GetCustomerByIdParams = {
  id: string;
  teamId: string;
};

export const getCustomerById = async (
  db: DatabaseOrTransaction,
  params: GetCustomerByIdParams,
) => {
  const { projectTotals, tagTotals } = customerRelationTotals(
    db,
    params.teamId,
  );
  const invoiceTotals = db
    .select({
      customerId: invoices.customerId,
      count: sql<number>`count(*)::int`.as("invoice_count"),
    })
    .from(invoices)
    .where(eq(invoices.teamId, params.teamId))
    .groupBy(invoices.customerId)
    .as("customer_invoice_counts");

  const [result] = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      billingEmail: customers.billingEmail,
      phone: customers.phone,
      website: customers.website,
      createdAt: customers.createdAt,
      teamId: customers.teamId,
      country: customers.country,
      addressLine1: customers.addressLine1,
      addressLine2: customers.addressLine2,
      city: customers.city,
      state: customers.state,
      zip: customers.zip,
      note: customers.note,
      vatNumber: customers.vatNumber,
      countryCode: customers.countryCode,
      token: customers.token,
      contact: customers.contact,
      // Customer relationship fields
      status: customers.status,
      preferredCurrency: customers.preferredCurrency,
      defaultPaymentTerms: customers.defaultPaymentTerms,
      isArchived: customers.isArchived,
      source: customers.source,
      externalId: customers.externalId,
      // Enrichment fields
      logoUrl: customers.logoUrl,
      description: customers.description,
      industry: customers.industry,
      companyType: customers.companyType,
      employeeCount: customers.employeeCount,
      foundedYear: customers.foundedYear,
      estimatedRevenue: customers.estimatedRevenue,
      fundingStage: customers.fundingStage,
      totalFunding: customers.totalFunding,
      headquartersLocation: customers.headquartersLocation,
      timezone: customers.timezone,
      linkedinUrl: customers.linkedinUrl,
      twitterUrl: customers.twitterUrl,
      instagramUrl: customers.instagramUrl,
      facebookUrl: customers.facebookUrl,
      ceoName: customers.ceoName,
      financeContact: customers.financeContact,
      financeContactEmail: customers.financeContactEmail,
      primaryLanguage: customers.primaryLanguage,
      fiscalYearEnd: customers.fiscalYearEnd,
      enrichmentStatus: customers.enrichmentStatus,
      enrichedAt: customers.enrichedAt,
      // Portal fields
      portalEnabled: customers.portalEnabled,
      portalId: customers.portalId,
      invoiceCount: sql<number>`coalesce(${invoiceTotals.count}, 0)`,
      projectCount: sql<number>`coalesce(${projectTotals.count}, 0)`,
      tags: sql<CustomerTag[]>`coalesce(${tagTotals.tags}, '[]'::json)`.as(
        "tags",
      ),
    })
    .from(customers)
    .where(
      and(eq(customers.id, params.id), eq(customers.teamId, params.teamId)),
    )
    .leftJoin(invoiceTotals, eq(invoiceTotals.customerId, customers.id))
    .leftJoin(projectTotals, eq(projectTotals.customerId, customers.id))
    .leftJoin(tagTotals, eq(tagTotals.customerId, customers.id));

  return result;
};

export type GetCustomersParams = {
  teamId: string;
  cursor?: string | null;
  pageSize?: number;
  q?: string | null;

  sort?: string[] | null;
};

export type CustomerTag = {
  id: string;
  name: string;
};

export const getCustomers = async (
  db: DatabaseOrTransaction,
  params: GetCustomersParams,
) => {
  const { teamId, sort, cursor, pageSize = 25, q } = params;

  const whereConditions: SQL[] = [eq(customers.teamId, teamId)];
  const { projectTotals, tagTotals } = customerRelationTotals(db, teamId);
  const invoiceTotals = customerInvoiceTotals(db, teamId);
  const invoiceCount = sql<number>`coalesce(${invoiceTotals.count}, 0)`;
  const projectCount = sql<number>`coalesce(${projectTotals.count}, 0)`;
  const totalRevenue = sql<
    number | null
  >`CASE WHEN ${invoiceTotals.customerId} IS NULL
    THEN 0 ELSE ${invoiceTotals.totalRevenue} END`;
  const outstandingAmount = sql<
    number | null
  >`CASE WHEN ${invoiceTotals.customerId} IS NULL
    THEN 0 ELSE ${invoiceTotals.outstandingAmount} END`;

  // Apply search query filter
  const search = q?.trim();
  if (search) {
    const query = buildSearchQuery(search);
    whereConditions.push(sql`(
      to_tsquery('english', ${query}) @@ ${customers.fts}
      OR ${customers.name} ILIKE '%' || ${search} || '%'
      OR ${customers.email} ILIKE '%' || ${search} || '%'
      OR ${customers.billingEmail} ILIKE '%' || ${search} || '%'
      OR ${customers.vatNumber} ILIKE '%' || ${search} || '%'
      OR ${customers.externalId} ILIKE '%' || ${search} || '%'
    )`);
  }

  // Start building the query
  const query = db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      billingEmail: customers.billingEmail,
      phone: customers.phone,
      website: customers.website,
      createdAt: customers.createdAt,
      teamId: customers.teamId,
      country: customers.country,
      addressLine1: customers.addressLine1,
      addressLine2: customers.addressLine2,
      city: customers.city,
      state: customers.state,
      zip: customers.zip,
      note: customers.note,
      vatNumber: customers.vatNumber,
      countryCode: customers.countryCode,
      token: customers.token,
      contact: customers.contact,
      // Customer relationship fields
      status: customers.status,
      isArchived: customers.isArchived,
      // Enrichment fields for list view
      logoUrl: customers.logoUrl,
      description: customers.description,
      industry: customers.industry,
      companyType: customers.companyType,
      employeeCount: customers.employeeCount,
      foundedYear: customers.foundedYear,
      estimatedRevenue: customers.estimatedRevenue,
      fundingStage: customers.fundingStage,
      totalFunding: customers.totalFunding,
      headquartersLocation: customers.headquartersLocation,
      timezone: customers.timezone,
      linkedinUrl: customers.linkedinUrl,
      twitterUrl: customers.twitterUrl,
      instagramUrl: customers.instagramUrl,
      facebookUrl: customers.facebookUrl,
      ceoName: customers.ceoName,
      financeContact: customers.financeContact,
      financeContactEmail: customers.financeContactEmail,
      primaryLanguage: customers.primaryLanguage,
      fiscalYearEnd: customers.fiscalYearEnd,
      enrichmentStatus: customers.enrichmentStatus,
      enrichedAt: customers.enrichedAt,
      // Portal fields
      portalEnabled: customers.portalEnabled,
      portalId: customers.portalId,
      invoiceCount,
      projectCount,
      totalRevenue,
      outstandingAmount,
      lastInvoiceDate: invoiceTotals.lastInvoiceDate,
      invoiceCurrency: invoiceTotals.currency,
      tags: sql<CustomerTag[]>`coalesce(${tagTotals.tags}, '[]'::json)`.as(
        "tags",
      ),
    })
    .from(customers)
    .leftJoin(invoiceTotals, eq(invoiceTotals.customerId, customers.id))
    .leftJoin(projectTotals, eq(projectTotals.customerId, customers.id))
    .leftJoin(tagTotals, eq(tagTotals.customerId, customers.id))
    .where(and(...whereConditions));

  // The ID tie-breaker makes equal totals/counts stable across offset pages.
  let order = desc(customers.createdAt);
  if (sort && sort.length === 2) {
    const [column, direction] = sort;
    const sortBy = direction === "asc" ? asc : desc;

    if (column === "name") {
      order = sortBy(customers.name);
    } else if (column === "created_at") {
      order = sortBy(customers.createdAt);
    } else if (column === "contact") {
      order = sortBy(customers.contact);
    } else if (column === "email") {
      order = sortBy(customers.email);
    } else if (column === "invoices") {
      order = sortBy(invoiceCount);
    } else if (column === "projects") {
      order = sortBy(projectCount);
    } else if (column === "tags") {
      order = sortBy(tagTotals.firstName);
    } else if (column === "industry") {
      order = sortBy(customers.industry);
    } else if (column === "country") {
      order = sortBy(customers.country);
    } else if (column === "total_revenue") {
      order = sql`${sortBy(totalRevenue)} nulls last`;
    } else if (column === "outstanding") {
      order = sql`${sortBy(outstandingAmount)} nulls last`;
    } else if (column === "last_invoice") {
      order = sortBy(invoiceTotals.lastInvoiceDate);
    }
  }
  query.orderBy(order, asc(customers.id));

  // Apply pagination
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  query.limit(pageSize).offset(offset);

  // Execute query
  const rows = await query;
  const data = rows.map((row) => ({
    ...row,
    // These REST fields are already optional. The existing table renders an
    // absent amount as "-"; returning a partial number would look complete.
    totalRevenue: row.totalRevenue ?? undefined,
    outstandingAmount: row.outstandingAmount ?? undefined,
  }));

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
};

export type UpsertCustomerParams = {
  id?: string;
  teamId: string;
  userId?: string;
  name: string;
  email: string;
  billingEmail?: string | null;
  country?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  note?: string | null;
  website?: string | null;
  phone?: string | null;
  contact?: string | null;
  vatNumber?: string | null;
  countryCode?: string | null;
  tags?: { id: string; name: string }[] | null;
};

export const upsertCustomer = async (
  db: Database,
  params: UpsertCustomerParams,
) => {
  const { id, tags: inputTags, teamId, userId, ...rest } = params;

  const token = id ? await generateToken(id) : undefined;

  const isNewCustomer = !id;

  return db.transaction(async (tx) => {
    await assertTeamOwnership(
      tx,
      teamId,
      "tags",
      inputTags?.map((tag) => tag.id) ?? [],
    );

    // Upsert customer
    const [customer] = await tx
      .insert(customers)
      .values({
        id,
        teamId,
        ...rest,
      })
      .onConflictDoUpdate({
        target: customers.id,
        setWhere: eq(customers.teamId, teamId),
        set: {
          name: rest.name,
          email: rest.email,
          billingEmail: rest.billingEmail,
          token,
          country: rest.country,
          addressLine1: rest.addressLine1,
          addressLine2: rest.addressLine2,
          city: rest.city,
          state: rest.state,
          zip: rest.zip,
          note: rest.note,
          website: rest.website,
          phone: rest.phone,
          contact: rest.contact,
          vatNumber: rest.vatNumber,
          countryCode: rest.countryCode,
        },
      })
      .returning();

    if (!customer) {
      throw new TenantResourceNotFoundError();
    }

    const customerId = customer.id;

    // Create activity for new customers only
    if (isNewCustomer) {
      await createActivity(tx, {
        teamId,
        userId,
        type: "customer_created",
        source: "user",
        priority: 7,
        metadata: {
          customerId: customerId,
          customerName: customer.name,
          customerEmail: customer.email,
          website: customer.website,
          country: customer.country,
          city: customer.city,
        },
      });
    }

    // Get current tags for the customer
    const currentCustomerTags = await tx
      .select({
        id: customerTags.id,
        tagId: customerTags.tagId,
        tag: {
          id: tags.id,
          name: tags.name,
        },
      })
      .from(customerTags)
      .where(
        and(
          eq(customerTags.customerId, customerId),
          eq(customerTags.teamId, teamId),
        ),
      )
      .leftJoin(tags, eq(tags.id, customerTags.tagId));

    const currentTagIds = new Set(currentCustomerTags.map((ct) => ct.tagId));
    const inputTagIds = new Set(inputTags?.map((t) => t.id) || []);

    // Tags to insert (in input but not current)
    const tagsToInsert =
      inputTags?.filter((tag) => !currentTagIds.has(tag.id)) || [];

    // Tags to delete (in current but not input)
    const tagIdsToDelete = Array.from(currentTagIds).filter(
      (tagId) => !inputTagIds.has(tagId),
    );

    // Insert new tag associations
    if (tagsToInsert.length > 0) {
      await tx.insert(customerTags).values(
        tagsToInsert.map((tag) => ({
          customerId,
          tagId: tag.id,
          teamId,
        })),
      );
    }

    // Delete removed tag associations
    if (tagIdsToDelete.length > 0) {
      await tx
        .delete(customerTags)
        .where(
          and(
            eq(customerTags.customerId, customerId),
            eq(customerTags.teamId, teamId),
            inArray(customerTags.tagId, tagIdsToDelete),
          ),
        );
    }

    // Return the customer with updated tags
    const [result] = await tx
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        billingEmail: customers.billingEmail,
        phone: customers.phone,
        website: customers.website,
        createdAt: customers.createdAt,
        teamId: customers.teamId,
        country: customers.country,
        addressLine1: customers.addressLine1,
        addressLine2: customers.addressLine2,
        city: customers.city,
        state: customers.state,
        zip: customers.zip,
        note: customers.note,
        vatNumber: customers.vatNumber,
        countryCode: customers.countryCode,
        token: customers.token,
        contact: customers.contact,
        // Enrichment fields
        logoUrl: customers.logoUrl,
        description: customers.description,
        industry: customers.industry,
        companyType: customers.companyType,
        employeeCount: customers.employeeCount,
        foundedYear: customers.foundedYear,
        estimatedRevenue: customers.estimatedRevenue,
        fundingStage: customers.fundingStage,
        totalFunding: customers.totalFunding,
        headquartersLocation: customers.headquartersLocation,
        timezone: customers.timezone,
        linkedinUrl: customers.linkedinUrl,
        twitterUrl: customers.twitterUrl,
        instagramUrl: customers.instagramUrl,
        facebookUrl: customers.facebookUrl,
        ceoName: customers.ceoName,
        financeContact: customers.financeContact,
        financeContactEmail: customers.financeContactEmail,
        primaryLanguage: customers.primaryLanguage,
        fiscalYearEnd: customers.fiscalYearEnd,
        enrichmentStatus: customers.enrichmentStatus,
        enrichedAt: customers.enrichedAt,
        // Portal fields
        portalEnabled: customers.portalEnabled,
        portalId: customers.portalId,
        invoiceCount: sql<number>`cast(count(${invoices.id}) as int)`,
        projectCount: sql<number>`cast(count(${trackerProjects.id}) as int)`,
        tags: sql<CustomerTag[]>`
          coalesce(
            json_agg(
              distinct jsonb_build_object(
                'id', ${tags.id},
                'name', ${tags.name}
              )
            ) filter (where ${tags.id} is not null),
            '[]'
          )
        `.as("tags"),
      })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.teamId, teamId)))
      .leftJoin(invoices, eq(invoices.customerId, customers.id))
      .leftJoin(trackerProjects, eq(trackerProjects.customerId, customers.id))
      .leftJoin(customerTags, eq(customerTags.customerId, customers.id))
      .leftJoin(tags, eq(tags.id, customerTags.tagId))
      .groupBy(customers.id);

    return result;
  });
};

export type DeleteCustomerParams = {
  id: string;
  teamId: string;
};

export const deleteCustomer = async (
  db: Database,
  params: DeleteCustomerParams,
) => {
  const { id, teamId } = params;

  // First, get the customer data before deleting it
  const customerToDelete = await getCustomerById(db, { id, teamId });

  if (!customerToDelete) {
    throw new Error("Customer not found");
  }

  // Delete the customer
  await db
    .delete(customers)
    .where(and(eq(customers.id, id), eq(customers.teamId, teamId)));

  // Return the deleted customer data
  return customerToDelete;
};

export type GetCustomerInvoiceSummaryParams = {
  customerId: string;
  teamId: string;
};

export async function getCustomerInvoiceSummary(
  db: Database,
  params: GetCustomerInvoiceSummaryParams,
) {
  const { customerId, teamId } = params;

  const [[team], invoiceData] = await Promise.all([
    db
      .select({ baseCurrency: teams.baseCurrency })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1),
    db
      .select({
        amount: invoices.amount,
        currency: invoices.currency,
        status: invoices.status,
      })
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), eq(invoices.teamId, teamId)),
      ),
  ]);

  const baseCurrency = team?.baseCurrency || "USD";

  if (invoiceData.length === 0) {
    return {
      totalAmount: 0,
      paidAmount: 0,
      outstandingAmount: 0,
      invoiceCount: 0,
      currency: baseCurrency,
    };
  }

  // Collect unique currencies that need conversion (excluding base currency)
  const currenciesToConvert = [
    ...new Set(
      invoiceData
        .map((inv) => inv.currency || baseCurrency)
        .filter((currency) => currency !== baseCurrency),
    ),
  ];

  const exchangeRateMap = new Map<string, number>();
  if (currenciesToConvert.length > 0) {
    const pairs = currenciesToConvert.map((c) => ({
      base: c,
      target: baseCurrency,
    }));
    const batchRates = await getExchangeRatesBatch(db, { pairs });
    for (const [key, rate] of batchRates) {
      const base = key.split(":")[0];
      if (base) exchangeRateMap.set(base, rate);
    }
  }

  // Convert all amounts to base currency and calculate totals
  let totalAmount = 0;
  let paidAmount = 0;
  let outstandingAmount = 0;
  let invoiceCount = 0;

  for (const invoice of invoiceData) {
    const amount = Number(invoice.amount) || 0;
    const currency = invoice.currency || baseCurrency;

    let convertedAmount = amount;
    let canConvert = true;

    // Convert to base currency if different
    if (currency !== baseCurrency) {
      const exchangeRate = exchangeRateMap.get(currency);
      if (exchangeRate) {
        convertedAmount = amount * exchangeRate;
      } else {
        // Skip invoices with missing exchange rates to avoid mixing currencies
        // This prevents silently producing incorrect totals
        canConvert = false;
      }
    }

    // Only include invoices that can be properly converted and are paid or outstanding
    // Draft, canceled, and scheduled invoices don't count toward financial totals
    if (canConvert) {
      if (invoice.status === "paid") {
        paidAmount += convertedAmount;
        totalAmount += convertedAmount;
        invoiceCount++;
      } else if (invoice.status === "unpaid" || invoice.status === "overdue") {
        outstandingAmount += convertedAmount;
        totalAmount += convertedAmount;
        invoiceCount++;
      }
    }
  }

  return {
    totalAmount: Math.round(totalAmount * 100) / 100,
    paidAmount: Math.round(paidAmount * 100) / 100,
    outstandingAmount: Math.round(outstandingAmount * 100) / 100,
    invoiceCount,
    currency: baseCurrency,
  };
}

export type ToggleCustomerPortalParams = {
  customerId: string;
  teamId: string;
  enabled: boolean;
};

/**
 * Toggle customer portal access.
 * Generates a portal_id (nanoid(21)) on first enable.
 */
export async function toggleCustomerPortal(
  db: Database,
  params: ToggleCustomerPortalParams,
) {
  const { customerId, teamId, enabled } = params;

  // Get current customer to check if portal_id exists
  const [currentCustomer] = await db
    .select({
      id: customers.id,
      portalId: customers.portalId,
    })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.teamId, teamId)))
    .limit(1);

  if (!currentCustomer) {
    throw new Error("Customer not found");
  }

  // Generate portal_id if enabling and doesn't exist yet
  const portalId =
    enabled && !currentCustomer.portalId
      ? nanoid(21)
      : currentCustomer.portalId;

  // Update the customer
  const [result] = await db
    .update(customers)
    .set({
      portalEnabled: enabled,
      portalId,
    })
    .where(and(eq(customers.id, customerId), eq(customers.teamId, teamId)))
    .returning({
      id: customers.id,
      portalEnabled: customers.portalEnabled,
      portalId: customers.portalId,
    });

  return result;
}

export type GetCustomerByPortalIdParams = {
  portalId: string;
};

/**
 * Get customer by portal ID for public portal page.
 * Only returns customer if portal is enabled.
 */
export async function getCustomerByPortalId(
  db: Database,
  params: GetCustomerByPortalIdParams,
) {
  const { portalId } = params;

  const [result] = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      website: customers.website,
      teamId: customers.teamId,
      portalEnabled: customers.portalEnabled,
      portalId: customers.portalId,
      team: {
        id: teams.id,
        name: teams.name,
        logoUrl: teams.logoUrl,
        baseCurrency: teams.baseCurrency,
      },
    })
    .from(customers)
    .innerJoin(teams, eq(teams.id, customers.teamId))
    .where(
      and(eq(customers.portalId, portalId), eq(customers.portalEnabled, true)),
    )
    .limit(1);

  return result;
}

export type GetCustomerPortalInvoicesParams = {
  customerId: string;
  teamId: string;
  cursor?: string | null;
  pageSize?: number;
};

/**
 * Get invoices for customer portal.
 * Only returns non-draft invoices (paid, unpaid, overdue).
 */
export async function getCustomerPortalInvoices(
  db: Database,
  params: GetCustomerPortalInvoicesParams,
) {
  const { customerId, teamId, cursor, pageSize = 10 } = params;

  const offset = cursor ? Number.parseInt(cursor, 10) : 0;

  const data = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      amount: invoices.amount,
      currency: invoices.currency,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      token: invoices.token,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, customerId),
        eq(invoices.teamId, teamId),
        // Only show paid, unpaid, overdue (exclude draft, canceled, scheduled, refunded)
        sql`${invoices.status} IN ('paid', 'unpaid', 'overdue')`,
      ),
    )
    .orderBy(desc(invoices.issueDate))
    .limit(pageSize)
    .offset(offset);

  const nextCursor =
    data.length === pageSize ? (offset + pageSize).toString() : null;

  return {
    data,
    nextCursor,
    hasMore: data.length === pageSize,
  };
}
