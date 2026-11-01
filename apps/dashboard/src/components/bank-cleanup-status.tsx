"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

/** Local deletion and remote provider confirmation are separate outcomes. */
export function BankCleanupStatus() {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.bankConnections.cleanupStatus.queryOptions(),
    refetchInterval: (state) =>
      state.state.data?.some(
        (row) => row.status === "pending" || row.status === "processing",
      )
        ? 15_000
        : false,
  });
  if (query.isError)
    return (
      <p className="py-3 text-sm text-muted-foreground" role="status">
        Provider cleanup status is currently unavailable.
      </p>
    );
  if (!query.data?.length) return null;
  const unresolved = query.data.filter((row) => row.status !== "completed");
  const recent = unresolved.length ? unresolved : query.data.slice(0, 3);
  return (
    <section
      className="py-4 space-y-2"
      aria-label="Provider connection cleanup"
    >
      <h3 className="text-sm font-medium">Provider connection cleanup</h3>
      <p className="text-xs text-muted-foreground">
        Removed connections may still need confirmation from the bank data
        provider.
      </p>
      <ul className="space-y-1 text-sm" aria-live="polite">
        {recent.map((row) => (
          <li key={row.id} className="flex flex-wrap justify-between gap-2">
            <span className="capitalize">
              {row.provider ?? "Bank provider"}
            </span>
            <span
              className={
                row.status === "reconciliation"
                  ? "text-destructive"
                  : "text-muted-foreground"
              }
            >
              {row.status === "completed"
                ? "Cleanup confirmed"
                : row.status === "reconciliation"
                  ? "Administrator review needed"
                  : row.status === "processing"
                    ? "Awaiting provider confirmation"
                    : row.lastError === "configuration_unavailable"
                      ? "Waiting for provider configuration"
                      : "Cleanup pending"}
            </span>
          </li>
        ))}
      </ul>
      {unresolved.some((row) => row.status === "reconciliation") && (
        <p className="text-xs text-muted-foreground">
          Ask your administrator to verify provider access. An unconfirmed
          request will not be repeated automatically.
        </p>
      )}
    </section>
  );
}
