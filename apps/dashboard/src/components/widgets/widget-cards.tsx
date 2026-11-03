"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import Link from "next/link";
import { describeSource } from "@/components/data-source-status";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatAmount, secondsToHoursAndMinutes } from "@/utils/format";

interface WidgetCardProps {
  label: string;
  href: string;
  value: string;
  detail?: string;
}

function WidgetCard({ label, href, value, detail }: WidgetCardProps) {
  return (
    <Link
      href={href}
      className="h-full border p-5 flex flex-col justify-between transition-all duration-300 bg-white border-[#e6e6e6] hover:bg-[#f7f7f7] hover:border-[#d0d0d0] dark:bg-[#0c0c0c] dark:border-[#1d1d1d] dark:hover:bg-[#0f0f0f] dark:hover:border-[#222222] cursor-pointer group min-h-[110px]"
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="mt-3">
        <span className="text-xl font-medium">{value}</span>
        {detail ? (
          <span className="text-xs text-muted-foreground ml-2">{detail}</span>
        ) : null}
      </div>
    </Link>
  );
}

export function WidgetCards() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.overview.summary.queryOptions());
  const { data: user } = useUserQuery();
  const locale = user?.locale;

  const cashValue =
    data.cashBalance.accountCount === 0
      ? "No accounts"
      : (formatAmount({
          amount: data.cashBalance.totalBalance,
          currency: data.cashBalance.currency,
          maximumFractionDigits: 0,
          locale,
        }) ?? "$0");

  const cashDetail = describeSource(data.sources.banking, "bank");

  const openValue = String(data.openInvoices.count);
  const openAmount = formatAmount({
    amount: data.openInvoices.totalAmount,
    currency: data.openInvoices.currency,
    maximumFractionDigits: 0,
    locale,
  });
  const openDetail =
    data.openInvoices.count > 0
      ? `${openAmount} outstanding`
      : "No open invoices";

  const hasUnbilledAmount = data.unbilledTime.totalAmount > 0;
  const unbilledTimeStr = secondsToHoursAndMinutes(
    data.unbilledTime.totalDuration,
  );
  const unbilledValue = hasUnbilledAmount
    ? (formatAmount({
        amount: data.unbilledTime.totalAmount,
        currency: data.unbilledTime.currency,
        maximumFractionDigits: 0,
        locale,
      }) ?? unbilledTimeStr)
    : unbilledTimeStr;

  const unbilledDetail = hasUnbilledAmount
    ? [
        unbilledTimeStr,
        data.unbilledTime.projectCount > 0
          ? `across ${data.unbilledTime.projectCount} ${data.unbilledTime.projectCount === 1 ? "project" : "projects"}`
          : null,
      ]
        .filter(Boolean)
        .join(" ")
    : data.unbilledTime.projectCount > 0
      ? `across ${data.unbilledTime.projectCount} ${data.unbilledTime.projectCount === 1 ? "project" : "projects"}`
      : undefined;

  const runwayValue =
    data.runway > 0
      ? `${data.runway} ${data.runway === 1 ? "mo" : "mos"}`
      : "-";
  const runwayDetail = data.runway > 0 ? "at current burn rate" : "No data yet";

  const reviewValue =
    data.sources.transactions.recordCount === 0
      ? "No transactions"
      : String(data.transactionsToReview.count);
  const reviewDetail =
    data.sources.transactions.recordCount === 0
      ? "Add manually or import CSV"
      : `${data.sources.transactions.recordCount} stored · ${data.transactionsToReview.count} ready to export`;

  const inboxValue =
    data.sources.inbox.recordCount === 0
      ? "No documents"
      : String(data.inboxPending.count);
  const inboxDetail = describeSource(data.sources.inbox, "inbox");

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full">
      <WidgetCard
        label="Recorded Cash Balance"
        href="/reports?scrollTo=cash-balance"
        value={cashValue}
        detail={cashDetail}
      />
      <WidgetCard
        label="Open Invoices"
        href="/invoices?statuses=draft,scheduled,unpaid"
        value={openValue}
        detail={openDetail}
      />
      <WidgetCard
        label="Unbilled Time"
        href="/tracker?status=in_progress"
        value={unbilledValue}
        detail={unbilledDetail}
      />
      <WidgetCard
        label="Transactions"
        href="/transactions?tab=review"
        value={reviewValue}
        detail={reviewDetail}
      />
      <WidgetCard
        label="Runway"
        href="/reports?scrollTo=runway"
        value={runwayValue}
        detail={runwayDetail}
      />
      <WidgetCard
        label="Inbox"
        href="/inbox?status=pending"
        value={inboxValue}
        detail={inboxDetail}
      />
    </div>
  );
}
