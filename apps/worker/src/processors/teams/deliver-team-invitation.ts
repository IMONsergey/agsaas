import {
  deliverTeamInvitation,
  TeamInvitationDeliveryPendingError,
} from "@midday/notifications/team-invitation-delivery";
import type { Job } from "bullmq";
import {
  type DeliverTeamInvitationPayload,
  deliverTeamInvitationSchema,
} from "../../schemas/teams";
import { getDb } from "../../utils/db";
import { NonRetryableError } from "../../utils/error-classification";
import { BaseProcessor } from "../base";

export class DeliverTeamInvitationProcessor extends BaseProcessor<DeliverTeamInvitationPayload> {
  protected getPayloadSchema() {
    return deliverTeamInvitationSchema;
  }
  async process(job: Job<DeliverTeamInvitationPayload>) {
    const result = await deliverTeamInvitation(getDb(), job.data);
    if (result.status === "pending")
      throw new TeamInvitationDeliveryPendingError();
    if (result.status === "reconciliation" || result.status === "rejected")
      throw new NonRetryableError(
        "Invitation email requires review",
        undefined,
        "validation",
      );
    return result;
  }
}
