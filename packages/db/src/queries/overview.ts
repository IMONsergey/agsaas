import type { SourceState } from "@midday/utils/data-freshness";
import { formatISO } from "date-fns";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import { getCashBalance } from "./bank-accounts";
import { getInboxByStatus } from "./inbox-matching";
import { getInvoiceSummary } from "./invoices";
import { getRunway } from "./reports";
import { getBillableHours } from "./tracker-entries";
import { getTransactionsReadyForExportCount } from "./transactions";

export type OverviewSummary = {
  openInvoices: {
    count: number;
    totalAmount: number;
    currency: string;
  };
  unbilledTime: {
    totalDuration: number;
    totalAmount: number;
    projectCount: number;
    currency: string;
  };
  inboxPending: {
    count: number;
  };
  transactionsToReview: {
    count: number;
  };
  cashBalance: {
    totalBalance: number;
    currency: string;
    accountCount: number;
  };
  runway: number;
  sources: {
    banking: SourceState;
    inbox: SourceState;
    transactions: { recordCount: number; latestStoredAt: string | null };
  };
};

export type GetOverviewSummaryParams = {
  teamId: string;
  currency?: string;
};

export async function getOverviewSummary(
  db: Database,
  params: GetOverviewSummaryParams,
): Promise<OverviewSummary> {
  const { teamId, currency } = params;
  const today = formatISO(new Date(), { representation: "date" });

  const [openInv, billable, pendingInbox, reviewCount, cash, runwayResult] =
    await Promise.all([
      getInvoiceSummary(db, {
        teamId,
        statuses: ["draft", "scheduled", "unpaid"],
      }),
      getBillableHours(db, { teamId, date: today, view: "month" }),
      getInboxByStatus(db, { teamId, status: "pending" }),
      getTransactionsReadyForExportCount(db, teamId),
      getCashBalance(db, { teamId, currency }),
      getRunway(db, { teamId, currency }),
    ]);

  const sourceRow = (
    await db.execute(sql`SELECT
    (SELECT count(*)::int FROM bank_connections WHERE team_id=${teamId}::uuid) AS bank_connections,
    (SELECT count(*)::int FROM bank_connections WHERE team_id=${teamId}::uuid AND status IS DISTINCT FROM 'connected') AS bank_failed,
    (SELECT count(last_accessed)::int FROM bank_connections WHERE team_id=${teamId}::uuid) AS bank_checked,
    (SELECT min(last_accessed)::text FROM bank_connections WHERE team_id=${teamId}::uuid) AS bank_oldest,
    (SELECT count(*)::int FROM transactions WHERE team_id=${teamId}::uuid) AS transactions,
    (SELECT max(created_at)::text FROM transactions WHERE team_id=${teamId}::uuid) AS latest_transaction,
    (SELECT count(*)::int FROM inbox_accounts WHERE team_id=${teamId}::uuid) AS inbox_connections,
    (SELECT count(*)::int FROM inbox_accounts WHERE team_id=${teamId}::uuid AND status IS DISTINCT FROM 'connected') AS inbox_failed,
    (SELECT count(last_accessed)::int FROM inbox_accounts WHERE team_id=${teamId}::uuid) AS inbox_checked,
    (SELECT min(last_accessed)::text FROM inbox_accounts WHERE team_id=${teamId}::uuid) AS inbox_oldest,
    (SELECT count(*)::int FROM inbox WHERE team_id=${teamId}::uuid) AS inbox_records
  `)
  ).rows[0]!;
  return {
    sources: {
      banking: {
        connectionCount: Number(sourceRow.bank_connections),
        failedCount: Number(sourceRow.bank_failed),
        checkedCount: Number(sourceRow.bank_checked),
        oldestCheckedAt: sourceRow.bank_oldest as string | null,
        recordCount: cash.accountCount,
      },
      inbox: {
        connectionCount: Number(sourceRow.inbox_connections),
        failedCount: Number(sourceRow.inbox_failed),
        checkedCount: Number(sourceRow.inbox_checked),
        oldestCheckedAt: sourceRow.inbox_oldest as string | null,
        recordCount: Number(sourceRow.inbox_records),
      },
      transactions: {
        recordCount: Number(sourceRow.transactions),
        latestStoredAt: sourceRow.latest_transaction as string | null,
      },
    },
    openInvoices: {
      count: openInv.invoiceCount,
      totalAmount: openInv.totalAmount,
      currency: openInv.currency,
    },
    unbilledTime: {
      totalDuration: billable.totalDuration,
      totalAmount: billable.totalAmount,
      projectCount: billable.projectBreakdown.length,
      currency: billable.currency,
    },
    inboxPending: {
      count: pendingInbox.length,
    },
    transactionsToReview: {
      count: reviewCount,
    },
    cashBalance: {
      totalBalance: cash.totalBalance,
      currency: cash.currency,
      accountCount: cash.accountCount,
    },
    runway: runwayResult.months,
  };
}
