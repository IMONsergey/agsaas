"use client";
import {
  type SourceState,
  sourceFreshness,
} from "@midday/utils/data-freshness";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTRPC } from "@/trpc/client";
export function describeSource(source: SourceState, label: string) {
  const status = sourceFreshness(source);
  const checked = source.oldestCheckedAt
    ? new Date(source.oldestCheckedAt).toLocaleString()
    : null;
  const descriptions = {
    not_connected: `No ${label} source connected.`,
    manual: `Stored entries only; no ${label} synchronization.`,
    awaiting: `${label} connection has no confirmed recent check.`,
    current: `Last ${label} provider check: ${checked}.`,
    stale: `${label} data may be stale. Oldest provider check: ${checked}.`,
    failed: `A ${label} connection needs attention. Displaying stored data.`,
  };
  return descriptions[status];
}
export function DataSourceStatus() {
  const trpc = useTRPC();
  const query = useQuery(trpc.overview.summary.queryOptions());
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking data sources…
      </p>
    );
  if (query.isError)
    return (
      <p role="alert" className="border p-4 text-sm">
        Source status could not be checked.{" "}
        <button
          type="button"
          className="underline"
          onClick={() => void query.refetch()}
        >
          Retry
        </button>
      </p>
    );
  return (
    <aside
      aria-label="Data sources"
      className="border p-4 mb-4 text-sm space-y-2"
    >
      <p>{describeSource(query.data.sources.banking, "bank")}</p>
      <p>
        {query.data.sources.transactions.recordCount} stored transactions.
        Reports reflect stored records and the selected period; they do not
        certify that every source is complete.
      </p>
      <p>
        <Link href="/settings/accounts" className="underline">
          Manage accounts
        </Link>
        {" · "}
        <Link href="/transactions?step=import" className="underline">
          Import transactions
        </Link>
      </p>
    </aside>
  );
}
