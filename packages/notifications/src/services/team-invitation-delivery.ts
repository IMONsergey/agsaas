import type { Database } from "@midday/db/client";
import {
  claimTeamInviteDelivery,
  deferTeamInviteDelivery,
  getTeamInviteDelivery,
  prepareTeamInviteDelivery,
  recordTeamInviteDeliveryOutcome,
  type TeamInviteDeliveryScope,
} from "@midday/db/queries/team-invite-deliveries";
import { validateTeamInviteEnvelope } from "@midday/db/team-invite-delivery";
import { InviteEmail } from "@midday/email/emails/invite";
import { getI18n } from "@midday/email/locales";
import { render } from "@midday/email/render";
import { EmailService, type InvoiceEnvelopeOutcome } from "./email-service";
import {
  getTeamInviteEmailConfig,
  TeamInvitationConfigurationError,
  type TeamInviteEmailConfig,
} from "./team-invitation-config";

export class TeamInvitationDeliveryPendingError extends Error {
  constructor() {
    super("Invitation email awaits durable recovery");
    this.name = "TeamInvitationDeliveryPendingError";
  }
}
export type TeamInvitationDeliveryResult = {
  status: "accepted" | "pending" | "canceled" | "rejected" | "reconciliation";
};
export type TeamInvitationSend = (
  envelope: string,
  idempotencyKey: string,
) => Promise<InvoiceEnvelopeOutcome>;

export async function deliverTeamInvitation(
  db: Database,
  scope: TeamInviteDeliveryScope,
  options: { send?: TeamInvitationSend; config?: TeamInviteEmailConfig } = {},
): Promise<TeamInvitationDeliveryResult> {
  try {
    let row = await getTeamInviteDelivery(db, scope);
    if (!row) return { status: "canceled" };
    if (
      row.status === "pending" &&
      !row.envelope &&
      row.firstAttemptAt === null
    ) {
      let envelope: string;
      try {
        const config = options.config ?? getTeamInviteEmailConfig();
        const { t } = getI18n({ locale: row.context.locale });
        const html = await render(
          InviteEmail({
            ...row.context,
            email: row.recipient,
            appUrl: config.appUrl,
            productName: config.productName,
          }),
        );
        envelope = JSON.stringify({
          from: config.from,
          to: [row.recipient],
          subject: t("invite.subject", {
            invitedByName: row.context.invitedByName,
            teamName: row.context.teamName,
          }),
          html,
          headers: { "X-Entity-Ref-ID": row.id },
        });
      } catch (error) {
        await deferTeamInviteDelivery(
          db,
          scope,
          error instanceof TeamInvitationConfigurationError
            ? "configuration_unavailable"
            : "preparation_failed",
        );
        return { status: "pending" };
      }
      row = await prepareTeamInviteDelivery(db, scope, envelope);
      if (!row) return { status: "canceled" };
    }
    // A prepared body stays unchanged when instance settings change. Missing
    // transport credentials must not consume the attempt budget or replay window.
    if (
      (row.status === "pending" || row.status === "sending") &&
      !options.send &&
      !process.env.RESEND_API_KEY?.trim()
    ) {
      await deferTeamInviteDelivery(db, scope, "configuration_unavailable");
      return { status: "pending" };
    }
    const claim = await claimTeamInviteDelivery(db, scope);
    if (claim.state === "missing") return { status: "canceled" };
    if (claim.state === "accepted") return { status: "accepted" };
    if (claim.state === "busy" || claim.state === "unprepared")
      return { status: "pending" };
    if (claim.state === "stopped")
      return {
        status:
          claim.delivery?.status === "canceled"
            ? "canceled"
            : claim.delivery?.status === "rejected"
              ? "rejected"
              : "reconciliation",
      };
    // Only an explicit claimed lease authorizes the external request.
    if (claim.state !== "claimed") return { status: "pending" };
    const delivery = claim.delivery;
    try {
      if (!delivery.envelope || !delivery.envelopeHash)
        throw new Error("Missing persisted envelope");
      validateTeamInviteEnvelope(
        delivery.envelope,
        delivery.envelopeHash,
        delivery.recipient,
      );
    } catch {
      await recordTeamInviteDeliveryOutcome(
        db,
        { ...scope, leaseToken: claim.leaseToken },
        { kind: "reconciliation", code: "envelope_integrity" },
      );
      return { status: "reconciliation" };
    }
    // The existing provider transport accepts any already rendered /emails body.
    // Its strict receipt/error classification is shared with invoice delivery;
    // no invoice lifecycle or state is involved in this invitation operation.
    const transport =
      options.send ??
      ((body, key) => new EmailService(db).sendInvoiceEnvelope(body, key));
    let outcome: InvoiceEnvelopeOutcome;
    try {
      outcome = await transport(
        delivery.envelope!,
        `agsaas-team-invite/${delivery.id}`,
      );
    } catch {
      outcome = { kind: "retry", code: "provider_uncertain" };
    }
    const recorded = await recordTeamInviteDeliveryOutcome(
      db,
      { ...scope, leaseToken: claim.leaseToken },
      outcome,
    );
    if (!recorded) {
      const current = await getTeamInviteDelivery(db, scope);
      return {
        status: !current
          ? "canceled"
          : current.status === "sending"
            ? "pending"
            : current.status,
      };
    }
    return {
      status: recorded.status === "sending" ? "pending" : recorded.status,
    };
  } catch {
    // Drizzle error causes can include bound recipient/HTML values. The DB
    // receipt and lease determine recovery, never raw errors in Redis/Sentry.
    throw new TeamInvitationDeliveryPendingError();
  }
}
