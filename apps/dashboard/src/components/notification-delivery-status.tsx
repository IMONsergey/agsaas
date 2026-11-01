"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { useQuery } from "@tanstack/react-query";
import { useInstanceCapabilities } from "@/hooks/use-instance-capabilities";
import { useTRPC } from "@/trpc/client";

const statusLabels: Record<string, string> = {
  pending: "Waiting",
  dispatching: "Processing",
  completed: "Processed",
  rejected: "Not sent",
  reconciliation: "Needs review",
};
const kindLabels: Record<string, string> = {
  notification: "Team notification",
  "payment-issue": "Payment reminder",
  "recurring-upcoming": "Upcoming invoice reminder",
};
function explanation(status: string, reason: string | null) {
  if (reason === "configuration_unavailable")
    return "Waiting for email delivery to be configured.";
  if (reason === "event_expired") return "This notification no longer applies.";
  if (status === "reconciliation")
    return "Delivery could not be confirmed. Review it before sending again.";
  if (status === "rejected") return "The notification could not be sent.";
  if (status === "pending") return "A retry is scheduled.";
  if (status === "completed")
    return "Processed according to recipients' notification preferences.";
  return "Delivery is in progress.";
}

export function NotificationDeliveryStatus() {
  const trpc = useTRPC();
  const capabilities = useInstanceCapabilities();
  const deliveries = useQuery(
    trpc.notifications.deliveryStatus.queryOptions(undefined, {
      refetchInterval: 30_000,
    }),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification delivery</CardTitle>
        <CardDescription>
          Recent team notifications and reminders. Invoice emails have their own
          status in each invoice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {capabilities.data && !capabilities.data.email.enabled && (
          <p
            className="rounded border p-3 text-sm text-muted-foreground"
            role="status"
          >
            Outgoing email is not configured. Email notifications will wait
            until your administrator connects a mail provider and sender
            address.
          </p>
        )}
        {deliveries.isPending && (
          <p className="text-sm text-muted-foreground" role="status">
            Loading delivery status...
          </p>
        )}
        {deliveries.isError && (
          <p className="text-sm text-destructive" role="alert">
            Delivery status is unavailable. Refresh this page to try again.
          </p>
        )}
        {deliveries.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No notification deliveries yet.
          </p>
        )}
        <ul className="divide-y">
          {deliveries.data?.slice(0, 10).map((delivery) => (
            <li key={delivery.id} className="py-3 first:pt-0">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span>{kindLabels[delivery.kind] || "Notification"}</span>
                <span
                  className={
                    delivery.status === "reconciliation" ||
                    delivery.status === "rejected"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {statusLabels[delivery.status] || "Unknown"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {explanation(delivery.status, delivery.lastError)}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
