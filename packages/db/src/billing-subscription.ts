export class BillingSubscriptionEventError extends Error {
  constructor() {
    super("Invalid billing subscription event");
    this.name = "BillingSubscriptionEventError";
  }
}

export type BillingProduct = {
  id: string;
  plan: "starter" | "pro";
};

export type BillingSubscriptionEvent = {
  teamId: string;
  subscriptionId: string;
  createdAt: string;
  modifiedAt: string;
  plan: "starter" | "pro";
  action: "active" | "trialing" | "canceled" | "past_due" | "revoked";
  cancelAtPeriodEnd: boolean;
  subscriptionStatus: "active" | "trialing" | "past_due" | null;
  email?: string;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingSubscriptionEventError();
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Provider identities must reject embedded control characters without normalizing them.
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BillingSubscriptionEventError();
  }
  return value;
}

/** Call only after the Polar SDK has verified and parsed the signed body.
 * Its modifiedAt contract is Date | null; neither webhook delivery time nor
 * local time is a substitute for the resource version. */
export function parseBillingSubscriptionEvent(
  verifiedEvent: unknown,
  products: readonly BillingProduct[],
): BillingSubscriptionEvent | null {
  const event = object(verifiedEvent);
  if (
    ![
      "subscription.created",
      "subscription.active",
      "subscription.canceled",
      "subscription.past_due",
      "subscription.revoked",
    ].includes(String(event.type))
  ) {
    return null;
  }

  const data = object(event.data);
  const metadata = object(data.metadata);
  const customer = object(data.customer);
  const teamId = identity(metadata.teamId).toLowerCase();
  const externalId = identity(customer.externalId).toLowerCase();
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(teamId) ||
    externalId !== teamId ||
    identity(customer.id) !== identity(data.customerId)
  ) {
    throw new BillingSubscriptionEventError();
  }

  const subscriptionId = identity(data.id);
  const productId = identity(data.productId);
  const matched = products.filter(
    (product) => !!product.id && product.id === productId,
  );
  if (
    matched.length !== 1 ||
    !(data.createdAt instanceof Date) ||
    !Number.isFinite(data.createdAt.getTime()) ||
    !(data.modifiedAt instanceof Date) ||
    !Number.isFinite(data.modifiedAt.getTime()) ||
    data.modifiedAt.getTime() < data.createdAt.getTime() ||
    typeof data.cancelAtPeriodEnd !== "boolean"
  ) {
    throw new BillingSubscriptionEventError();
  }

  let action: BillingSubscriptionEvent["action"];
  switch (event.type) {
    case "subscription.created":
      if (data.status !== "trialing" && data.status !== "active") return null;
      action = data.status;
      break;
    case "subscription.active":
      if (data.status !== "active") throw new BillingSubscriptionEventError();
      action = "active";
      break;
    case "subscription.canceled":
      if (data.status === "canceled" || data.status === "unpaid") {
        // The canceled and revoked deliveries can describe the same terminal
        // resource version. Both must revoke, whichever is delivered first.
        action = "revoked";
      } else if (
        data.cancelAtPeriodEnd &&
        ["active", "trialing", "past_due"].includes(String(data.status))
      ) {
        action = "canceled";
      } else {
        throw new BillingSubscriptionEventError();
      }
      break;
    case "subscription.past_due":
      if (data.status !== "past_due") throw new BillingSubscriptionEventError();
      action = "past_due";
      break;
    case "subscription.revoked":
      // Preserve Polar's legacy revoked event for a recoverable payment issue.
      if (data.status === "past_due") action = "past_due";
      else if (data.status === "canceled" || data.status === "unpaid")
        action = "revoked";
      else throw new BillingSubscriptionEventError();
      break;
    default:
      return null;
  }

  return {
    teamId,
    subscriptionId,
    createdAt: data.createdAt.toISOString(),
    modifiedAt: data.modifiedAt.toISOString(),
    plan: matched[0]!.plan,
    action,
    cancelAtPeriodEnd: data.cancelAtPeriodEnd,
    subscriptionStatus:
      action === "revoked"
        ? null
        : (data.status as "active" | "trialing" | "past_due"),
    ...(typeof customer.email === "string" && customer.email.length <= 320
      ? { email: customer.email }
      : {}),
  };
}
