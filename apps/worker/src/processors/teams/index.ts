import { CancellationEmailFollowupProcessor } from "./cancellation-email-followup";
import { CancellationEmailsProcessor } from "./cancellation-emails";
import { DeleteTeamProcessor } from "./delete-team";
import { DeliverTeamInvitationProcessor } from "./deliver-team-invitation";
import { PaymentIssueProcessor } from "./payment-issue";
import { ReconcileBankConnectionsProcessor } from "./reconcile-bank-connections";
import { ReconcileTeamInvitationsProcessor } from "./reconcile-team-invitations";

/**
 * Export all team processors (for type imports)
 */
export { CancellationEmailFollowupProcessor } from "./cancellation-email-followup";
export { CancellationEmailsProcessor } from "./cancellation-emails";
export { DeleteTeamProcessor } from "./delete-team";
export { PaymentIssueProcessor } from "./payment-issue";

/**
 * Team processor registry
 * Maps job names to processor instances
 */
export const teamProcessors = {
  "deliver-team-invitation": new DeliverTeamInvitationProcessor(),
  "reconcile-team-invitations": new ReconcileTeamInvitationsProcessor(),
  "reconcile-bank-connections": new ReconcileBankConnectionsProcessor(),
  "delete-team": new DeleteTeamProcessor(),
  "cancellation-email-immediate": new CancellationEmailsProcessor(),
  "cancellation-email-followup": new CancellationEmailFollowupProcessor(),
  "payment-issue": new PaymentIssueProcessor(),
};
