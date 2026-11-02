"use client";

import { Button } from "@midday/ui/button";
import { Card } from "@midday/ui/card";
import { useToast } from "@midday/ui/use-toast";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

export function SubscriptionOptions() {
  const trpc = useTRPC();
  const { toast } = useToast();
  const checkout = useMutation(
    trpc.billing.createCheckout.mutationOptions({
      onSuccess: ({ url }) => {
        window.location.assign(url);
      },
      onError: (error) =>
        toast({
          title: "Checkout unavailable",
          description: error.message,
          variant: "error",
        }),
    }),
  );
  return (
    <Card className="p-4 space-y-4">
      <div className="space-y-1">
        <h2 className="font-medium">Choose a subscription</h2>
        <p className="text-sm text-muted-foreground">
          The payment provider shows the final price and terms before you
          confirm payment.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {(["starter", "pro"] as const).flatMap((plan) =>
          (["monthly", "yearly"] as const).map((planType) => (
            <Button
              key={`${plan}-${planType}`}
              variant="outline"
              disabled={checkout.isPending}
              onClick={() =>
                checkout.mutate({
                  plan,
                  planType,
                  embedOrigin: window.location.origin,
                })
              }
            >
              {plan === "pro" ? "Pro" : "Starter"} · {planType}
            </Button>
          )),
        )}
      </div>
    </Card>
  );
}
