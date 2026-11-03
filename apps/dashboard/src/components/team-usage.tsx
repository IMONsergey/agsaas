"use client";
import { Button } from "@midday/ui/button";
import { Card } from "@midday/ui/card";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

const labels = {
  users: "Members",
  bankConnections: "Bank connections",
  connectors: "AI connectors",
  storage: "Team storage",
  inbox: "Inbox this month",
  invoices: "Invoices first issued this month",
};
export function TeamUsage() {
  const trpc = useTRPC();
  const query = useQuery(trpc.team.entitlements.queryOptions());
  if (query.isPending)
    return (
      <p role="status" className="text-sm">
        Loading workspace usage...
      </p>
    );
  if (query.isError)
    return (
      <p role="alert" className="text-sm">
        Workspace usage is unavailable.{" "}
        <Button variant="outline" onClick={() => query.refetch()}>
          Retry
        </Button>
      </p>
    );
  const data = query.data;
  return (
    <Card className="p-4 space-y-3">
      <h3 className="font-medium">Workspace allowance</h3>
      <p className="text-xs text-muted-foreground">
        Effective plan: {data.effectivePlan}. Monthly usage resets on{" "}
        {new Date(data.resetsAt).toLocaleDateString()} (UTC).
      </p>
      {data.pastDue && (
        <p role="alert" className="text-sm">
          New allocations are paused until the subscription payment is resolved.
          Reading and exporting existing data remains available.
        </p>
      )}
      {data.effectivePlan === "trial" && data.trialEndsAt && (
        <p className="text-xs">
          Trial ends on {new Date(data.trialEndsAt).toLocaleDateString()}.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {Object.entries(labels).map(([key, label]) => {
          const resource = key as keyof typeof labels;
          const value = (n: number) =>
            resource === "storage"
              ? `${(n / 1024 ** 3).toFixed(2)} GiB`
              : String(n);
          return (
            <div key={key} className="contents">
              <dt>{label}</dt>
              <dd className="text-right">
                {resource === "storage" && !data.storageMetadataComplete
                  ? "Needs reconciliation"
                  : `${value(data.usage[resource])} / ${value(data.limits[resource])}`}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="text-xs text-muted-foreground">
        A downgrade keeps existing data. New allocations stop at the allowance.
        Deleting Inbox items or issued invoices does not reset monthly usage.
        Pending connections keep their allocation until confirmed removal.
      </p>
    </Card>
  );
}
