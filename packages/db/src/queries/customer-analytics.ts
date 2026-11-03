import { parseISO } from "date-fns";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../client";
import { customers, invoices } from "../schema";

/**
 * Revenue concentration data for a period
 */
export type RevenueConcentration = {
  topCustomer: {
    id: string;
    name: string;
    revenue: number;
    percentage: number;
  } | null;
  totalRevenue: number;
  customerCount: number;
  isConcentrated: boolean; // >50% from one customer
  currency: string;
};

export type GetRevenueConcentrationParams = {
  teamId: string;
  from: string;
  to: string;
  currency: string;
};

/**
 * Calculate revenue concentration for a period.
 * Returns the top customer and their share of total revenue.
 * Warns if a single customer accounts for >50% of revenue.
 */
export async function getRevenueConcentration(
  db: Database,
  params: GetRevenueConcentrationParams,
): Promise<RevenueConcentration> {
  const { teamId, from, to, currency } = params;

  // Get revenue by customer for the period
  const customerRevenue = await db
    .select({
      customerId: customers.id,
      customerName: customers.name,
      revenue: sql<number>`SUM(${invoices.amount})::float`,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.teamId, teamId),
        gte(invoices.paidAt, from),
        lte(invoices.paidAt, to),
        eq(invoices.status, "paid"),
        eq(invoices.currency, currency),
      ),
    )
    .groupBy(customers.id, customers.name)
    .orderBy(sql`SUM(${invoices.amount}) DESC`);

  if (customerRevenue.length === 0) {
    return {
      topCustomer: null,
      totalRevenue: 0,
      customerCount: 0,
      isConcentrated: false,
      currency,
    };
  }

  const totalRevenue = customerRevenue.reduce((sum, c) => sum + c.revenue, 0);
  const topCustomerData = customerRevenue[0];

  if (!topCustomerData) {
    return {
      topCustomer: null,
      totalRevenue,
      customerCount: customerRevenue.length,
      isConcentrated: false,
      currency,
    };
  }

  const topCustomerPercentage = (topCustomerData.revenue / totalRevenue) * 100;

  return {
    topCustomer: {
      id: topCustomerData.customerId,
      name: topCustomerData.customerName,
      revenue: topCustomerData.revenue,
      percentage: Math.round(topCustomerPercentage),
    },
    totalRevenue,
    customerCount: customerRevenue.length,
    isConcentrated: topCustomerPercentage > 50,
    currency,
  };
}

export type GetTopRevenueClientParams = {
  teamId: string;
};

/** Net confirmed cash received during the last 30 days, in one reporting currency. */
export async function getTopRevenueClient(
  db: Database,
  params: GetTopRevenueClientParams,
) {
  type Row = {
    customerId: string | null;
    customerName: string | null;
    totalRevenue: number | null;
    currency: string | null;
    invoiceCount: number;
    incomplete: boolean;
  };
  const result = await db.execute<Row>(sql`WITH flows AS (
    SELECT i.customer_id, i.id invoice_id, upper(i.currency) currency,
      e.amount_minor::numeric * CASE WHEN e.kind='refund' THEN -1 ELSE 1 END * i.amount /
      NULLIF((s.projection->>'invoiceAmountMinor')::numeric,0) amount
    FROM invoice_settlement_entries e JOIN invoices i ON i.id=e.invoice_id AND i.team_id=e.team_id
    LEFT JOIN invoice_settlement_state s ON s.invoice_id=i.id AND s.team_id=i.team_id
    WHERE e.team_id=${params.teamId}::uuid AND e.occurred_at>=clock_timestamp()-interval '30 days' AND e.occurred_at<=clock_timestamp()
    UNION ALL
    SELECT i.customer_id,i.id,upper(i.currency),i.amount FROM invoices i
    WHERE i.team_id=${params.teamId}::uuid AND i.status='paid' AND i.paid_at>=clock_timestamp()-interval '30 days'
      AND i.paid_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM invoice_settlement_entries e WHERE e.invoice_id=i.id)
  ), reporting AS (
    SELECT coalesce(CASE WHEN t.base_currency ~ '^[A-Z]{3}$' THEN t.base_currency END,
      (SELECT CASE WHEN count(distinct currency)=1 THEN min(currency) END FROM flows)) currency FROM teams t WHERE t.id=${params.teamId}::uuid
  ), converted AS (
    SELECT f.*,r.currency reporting_currency,CASE WHEN f.currency=r.currency THEN f.amount ELSE f.amount*x.rate END converted
    FROM flows f CROSS JOIN reporting r LEFT JOIN exchange_rates x ON x.base=f.currency AND x.target=r.currency AND x.rate>0
  ), complete AS (SELECT count(*) FILTER(WHERE converted IS NULL)>0 incomplete FROM converted), ranked AS (
    SELECT c.id "customerId",c.name "customerName",round(sum(f.converted),2)::float "totalRevenue",min(f.reporting_currency) currency,
      count(distinct f.invoice_id)::int "invoiceCount",false incomplete
    FROM converted f JOIN customers c ON c.id=f.customer_id AND c.team_id=${params.teamId}::uuid
    WHERE NOT (SELECT incomplete FROM complete) GROUP BY c.id,c.name HAVING sum(f.converted)>0
    ORDER BY sum(f.converted) DESC,c.id LIMIT 1
  ) SELECT * FROM ranked UNION ALL SELECT NULL,NULL,NULL,(SELECT currency FROM reporting),0,true FROM complete WHERE incomplete`);
  return result.rows[0] ?? null;
}

export type GetNewCustomersCountParams = {
  teamId: string;
};

export async function getNewCustomersCount(
  db: Database,
  params: GetNewCustomersCountParams,
) {
  const { teamId } = params;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [result] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(customers)
    .where(
      and(
        eq(customers.teamId, teamId),
        gte(customers.createdAt, thirtyDaysAgo.toISOString()),
      ),
    );

  return result?.count || 0;
}

export type GetCustomerLifetimeValueParams = {
  teamId: string;
  currency?: string;
};

export async function getCustomerLifetimeValue(
  db: Database,
  params: GetCustomerLifetimeValueParams,
) {
  const { teamId, currency } = params;

  // Get all customers with their lifetime value
  const customerValues = await db
    .select({
      customerId: customers.id,
      customerName: customers.name,
      customerCreatedAt: customers.createdAt,
      totalRevenue: sql<number>`COALESCE(SUM(${invoices.amount}), 0)::float`,
      invoiceCount: sql<number>`COUNT(${invoices.id})::int`,
      firstInvoiceDate: sql<string>`MIN(${invoices.createdAt})`,
      lastInvoiceDate: sql<string>`MAX(${invoices.createdAt})`,
      currency: invoices.currency,
    })
    .from(customers)
    .leftJoin(
      invoices,
      and(
        eq(invoices.customerId, customers.id),
        inArray(invoices.status, ["paid", "unpaid", "overdue"]), // Exclude drafts
        currency ? eq(invoices.currency, currency) : sql`true`,
      ),
    )
    .where(eq(customers.teamId, teamId))
    .groupBy(
      customers.id,
      customers.name,
      customers.createdAt,
      invoices.currency,
    )
    .having(sql`COUNT(${invoices.id}) > 0`); // Only customers with invoices

  if (customerValues.length === 0) {
    return {
      summary: {
        averageCLV: 0,
        medianCLV: 0,
        totalCustomers: 0,
        activeCustomers: 0,
        averageLifespanDays: 0,
        currency: currency || "USD",
      },
      topCustomers: [],
      meta: {
        type: "customer_lifetime_value",
        currency: currency || "USD",
      },
    };
  }

  // Calculate customer lifespans and active status
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const customersWithMetrics = customerValues.map((customer) => {
    const lastInvoice = parseISO(customer.lastInvoiceDate);
    const firstInvoice = parseISO(customer.firstInvoiceDate);

    // Calculate lifespan (from first invoice to last invoice or now)
    const lifespanMs = lastInvoice.getTime() - firstInvoice.getTime();
    const lifespanDays = Math.max(
      1,
      Math.floor(lifespanMs / (1000 * 60 * 60 * 24)),
    );

    // Is customer active? (invoice in last 30 days)
    const isActive = lastInvoice >= thirtyDaysAgo;

    return {
      customerId: customer.customerId,
      customerName: customer.customerName,
      totalRevenue: customer.totalRevenue,
      invoiceCount: customer.invoiceCount,
      lifespanDays,
      isActive,
      currency: customer.currency || currency || "USD",
    };
  });

  // Calculate summary statistics
  const totalRevenue = customersWithMetrics.reduce(
    (sum, c) => sum + c.totalRevenue,
    0,
  );
  const totalCustomers = customersWithMetrics.length;
  const activeCustomers = customersWithMetrics.filter((c) => c.isActive).length;

  const averageCLV = totalRevenue / totalCustomers;

  // Calculate median CLV
  const sortedValues = customersWithMetrics
    .map((c) => c.totalRevenue)
    .sort((a, b) => a - b);
  const medianCLV =
    sortedValues.length % 2 === 0
      ? ((sortedValues[sortedValues.length / 2 - 1] ?? 0) +
          (sortedValues[sortedValues.length / 2] ?? 0)) /
        2
      : (sortedValues[Math.floor(sortedValues.length / 2)] ?? 0);

  // Average lifespan
  const averageLifespanDays =
    customersWithMetrics.reduce((sum, c) => sum + c.lifespanDays, 0) /
    totalCustomers;

  // Get top 5 customers by CLV
  const topCustomers = customersWithMetrics
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 5)
    .map((c) => ({
      customerId: c.customerId,
      customerName: c.customerName,
      lifetimeValue: Number(c.totalRevenue.toFixed(2)),
      invoiceCount: c.invoiceCount,
      lifespanDays: c.lifespanDays,
      isActive: c.isActive,
      currency: c.currency,
    }));

  const mainCurrency = customerValues[0]?.currency || currency || "USD";

  return {
    summary: {
      averageCLV: Number(averageCLV.toFixed(2)),
      medianCLV: Number((medianCLV ?? 0).toFixed(2)),
      totalCustomers,
      activeCustomers,
      averageLifespanDays: Math.round(averageLifespanDays),
      currency: mainCurrency,
    },
    topCustomers,
    meta: {
      type: "customer_lifetime_value",
      currency: mainCurrency,
    },
  };
}
