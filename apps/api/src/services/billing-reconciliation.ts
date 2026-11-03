import {
  type BillingProduct,
  parseBillingSubscriptionEvent,
} from "@midday/db/billing-subscription";

export type BillingReconciliationBinding = {
  teamId: string;
  subscriptionId: string;
};
/** Provider GET is outside SQL; the repository compares the binding again under its team lock. */
export async function reconcileBillingSubscription(input: {
  teamId: string;
  products: readonly BillingProduct[];
  readBinding: () => Promise<BillingReconciliationBinding | null>;
  readProvider: (id: string) => Promise<unknown>;
  apply: (
    event: unknown,
    binding: BillingReconciliationBinding,
  ) => Promise<unknown>;
}) {
  const binding = await input.readBinding();
  if (!binding || binding.teamId !== input.teamId)
    return { state: "requires_binding" as const };
  const resource = await input.readProvider(binding.subscriptionId);
  const event = { type: "subscription.updated", data: resource };
  const parsed = parseBillingSubscriptionEvent(event, input.products);
  if (
    !parsed ||
    parsed.teamId !== binding.teamId ||
    parsed.subscriptionId !== binding.subscriptionId
  )
    throw new Error(
      "Provider subscription does not match the stored team binding",
    );
  return input.apply(event, binding);
}
