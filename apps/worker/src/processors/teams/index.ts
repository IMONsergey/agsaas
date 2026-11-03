import { CancellationEmailFollowupProcessor } from "./cancellation-email-followup";
import { CancellationEmailsProcessor } from "./cancellation-emails";
import { DeleteTeamProcessor } from "./delete-team";
import { DeliverOnboardingProcessor } from "./deliver-onboarding";
import { DeliverTeamInvitationProcessor } from "./deliver-team-invitation";
import { PaymentIssueProcessor } from "./payment-issue";
import { ReconcileBankConnectionsProcessor } from "./reconcile-bank-connections";
import { ReconcileBankSyncProcessor } from "./reconcile-bank-sync";
import { ReconcileOnboardingProcessor } from "./reconcile-onboarding";
import { ReconcileResourceCleanupsProcessor } from "./reconcile-resource-cleanups";
import { ReconcileTeamInvitationsProcessor } from "./reconcile-team-invitations";
import { SyncBankConnectionProcessor } from "./sync-bank-connection";

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
  "sync-bank-connection": new SyncBankConnectionProcessor(),
  "reconcile-bank-sync": new ReconcileBankSyncProcessor(),
  "deliver-onboarding": new DeliverOnboardingProcessor(),
  "reconcile-onboarding": new ReconcileOnboardingProcessor(),
  "reconcile-resource-cleanups": new ReconcileResourceCleanupsProcessor(),
  "deliver-team-invitation": new DeliverTeamInvitationProcessor(),
  "reconcile-team-invitations": new ReconcileTeamInvitationsProcessor(),
  "reconcile-bank-connections": new ReconcileBankConnectionsProcessor(),
  "delete-team": new DeleteTeamProcessor(),
  "cancellation-email-immediate": new CancellationEmailsProcessor(),
  "cancellation-email-followup": new CancellationEmailFollowupProcessor(),
  "payment-issue": new PaymentIssueProcessor(),
};
