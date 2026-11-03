"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@midday/ui/card";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTeamQuery } from "@/hooks/use-team";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { FormatAmount } from "./format-amount";

export function TopRevenueClient() {
  const trpc = useTRPC();
  const { data: team } = useTeamQuery();
  const { data: user } = useUserQuery();
  const { data } = useSuspenseQuery(
    trpc.invoice.topRevenueClient.queryOptions(),
  );

  if (data?.incomplete)
    return (
      <Card className="hidden sm:block">
        <CardHeader>
          <CardTitle>Top Paying Client</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          A complete currency conversion is unavailable. Refresh exchange rates
          to compare clients.
        </CardContent>
      </Card>
    );
  if (!data) {
    return (
      <Card className="hidden sm:block">
        <CardHeader className="pb-2">
          <CardTitle className="font-medium text-2xl font-serif">
            No Recorded Receipts
          </CardTitle>
        </CardHeader>

        <CardContent className="pb-5">
          <div className="flex flex-col gap-2">
            <div>Top Paying Client</div>
            <div className="text-sm text-muted-foreground">
              No net recorded receipts in the past 30 days
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="hidden sm:block">
      <CardHeader className="pb-2">
        <CardTitle className="font-medium text-2xl font-serif">
          {data.customerName}
        </CardTitle>
      </CardHeader>

      <CardContent className="pb-5">
        <div className="flex flex-col gap-2">
          <div>Top Paying Client</div>
          <div className="text-sm text-muted-foreground">
            <FormatAmount
              amount={data.totalRevenue ?? 0}
              currency={data.currency || team?.baseCurrency || "USD"}
              locale={user?.locale ?? undefined}
            />{" "}
            from {data.invoiceCount} invoice{data.invoiceCount !== 1 ? "s" : ""}{" "}
            in net recorded receipts, past 30 days
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
