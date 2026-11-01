import { Card } from "@midday/ui/card";
import type { Metadata } from "next";
import { ManageSubscription } from "@/components/manage-subscription";
import { Orders } from "@/components/orders";
import { SubscriptionOptions } from "@/components/subscription-options";
import { getQueryClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = { title: "Billing | AGSaaS" };

export default async function Billing() {
  const queryClient = getQueryClient();
  const [user, capabilities] = await Promise.all([
    queryClient.fetchQuery(trpc.user.me.queryOptions()),
    queryClient.fetchQuery(trpc.apps.capabilities.queryOptions()),
  ]);
  if (!capabilities.billing.enabled)
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">Billing</h2>
        <Card className="p-4 space-y-2">
          <p className="text-sm font-medium">Self-hosted workspace</p>
          <p className="text-sm text-muted-foreground">
            Subscriptions are not enabled for this installation. Billing setup
            is managed by your workspace administrator.
          </p>
        </Card>
      </div>
    );
  const team = user?.team;
  prefetch(
    trpc.billing.orders.infiniteQueryOptions(
      { pageSize: 15 },
      { getNextPageParam: ({ meta }) => meta?.cursor },
    ),
  );
  return (
    <div className="space-y-12">
      {team?.plan !== "trial" ? (
        <ManageSubscription />
      ) : (
        <SubscriptionOptions />
      )}
      <Orders />
    </div>
  );
}
