import { createHash } from "node:crypto";
import type { Database } from "@midday/db/client";
import {
  claimOnboardingDelivery,
  deferOnboardingDelivery,
  getOnboardingDelivery,
  type OnboardingOutcome,
  type OnboardingScope,
  prepareOnboardingDelivery,
  recordOnboardingOutcome,
} from "@midday/db/queries/onboarding-deliveries";
import {
  getProductEmailConfig,
  isProductEmailTransportAvailable,
  type ProductEmailConfig,
} from "@midday/email/config";
import { TrialActivationEmail } from "@midday/email/emails/trial-activation";
import { WelcomeEmail } from "@midday/email/emails/welcome";
import { render } from "@midday/email/render";
import { EmailService } from "./email-service";

export class OnboardingDeliveryPendingError extends Error {
  constructor() {
    super("Onboarding email awaits durable recovery");
    this.name = "OnboardingDeliveryPendingError";
  }
}

/** Actual recipient and preferences are reread by the SQL claim immediately
 * before HTTP. A lost/uncertain acknowledgement is never blindly resent. */
export async function deliverOnboarding(
  db: Database,
  scope: OnboardingScope,
  options: {
    config?: ProductEmailConfig;
    send?: (
      envelope: string,
      idempotencyKey: string,
    ) => Promise<OnboardingOutcome>;
  } = {},
) {
  try {
    for (let preparation = 0; preparation < 2; preparation++) {
      const row = await getOnboardingDelivery(db, scope);
      if (!row) return { status: "canceled" as const };
      if (!["pending", "sending"].includes(row.status))
        return { status: row.status };
      if (row.status === "pending" && row.context.eligible) {
        if (!options.send && !isProductEmailTransportAvailable()) {
          await deferOnboardingDelivery(db, scope, "configuration_unavailable");
          return {
            status: "pending" as const,
            reason: "configuration_unavailable",
          };
        }
        if (!row.envelope || row.contextHash !== row.context.hash) {
          if (row.firstAttemptAt) {
            // Claim transitions an identity change after an attempt to review.
            const claim = await claimOnboardingDelivery(db, scope);
            return { status: claim.state === "busy" ? "pending" : claim.state };
          }
          let envelope: string;
          try {
            const config = options.config ?? getProductEmailConfig();
            const html = await render(
              row.kind === "welcome"
                ? WelcomeEmail({ fullName: row.context.fullName })
                : TrialActivationEmail({ fullName: row.context.fullName }),
            );
            envelope = JSON.stringify({
              from: config.from,
              ...(config.replyTo ? { reply_to: config.replyTo } : {}),
              to: [row.context.recipient],
              subject:
                row.kind === "welcome"
                  ? `Welcome to ${config.productName}`
                  : "Connect your bank to see your transactions",
              html,
              headers: { "X-Entity-Ref-ID": row.id },
            });
          } catch {
            await deferOnboardingDelivery(db, scope, "preparation_failed");
            return { status: "pending" as const, reason: "preparation_failed" };
          }
          if (
            !(await prepareOnboardingDelivery(
              db,
              scope,
              row.context.hash,
              envelope,
            ))
          )
            continue;
        }
      }
      const claim = await claimOnboardingDelivery(db, scope);
      if (claim.state === "unprepared") continue;
      if (claim.state !== "claimed")
        return { status: claim.state === "busy" ? "pending" : claim.state };
      const leased = { ...scope, leaseToken: claim.leaseToken };
      try {
        const body = JSON.parse(claim.envelope);
        if (
          createHash("sha256").update(claim.envelope).digest("hex") !==
            claim.envelopeHash ||
          !Array.isArray(body.to) ||
          body.to.length !== 1 ||
          body.to[0] !== claim.recipient ||
          body.cc ||
          body.bcc
        )
          throw new Error("Invalid onboarding envelope");
      } catch {
        return {
          status: await recordOnboardingOutcome(db, leased, {
            kind: "reconciliation",
            code: "envelope_integrity",
          }),
        };
      }
      let outcome: OnboardingOutcome;
      try {
        const transport =
          options.send ??
          ((body, key) => new EmailService(db).sendInvoiceEnvelope(body, key));
        outcome = await transport(
          claim.envelope,
          `agsaas-onboarding/${scope.deliveryId}`,
        );
      } catch {
        outcome = { kind: "reconciliation", code: "provider_uncertain" };
      }
      return { status: await recordOnboardingOutcome(db, leased, outcome) };
    }
    return { status: "pending" as const };
  } catch {
    // Persisted sending leases remain visible for reconciliation if SQL failed
    // after the provider accepted. Never propagate recipient/HTML/SQL causes.
    throw new OnboardingDeliveryPendingError();
  }
}
