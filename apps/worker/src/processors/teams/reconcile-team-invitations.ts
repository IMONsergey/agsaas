import { listRecoverableTeamInviteDeliveries } from "@midday/db/queries";
import { deliverTeamInvitation } from "@midday/notifications/team-invitation-delivery";
import type { Job } from "bullmq";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";

/** A Redis failure or removed job cannot remove the committed SQL intent. */
export class ReconcileTeamInvitationsProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job<Record<string, never>>) {
    const db = getDb();
    const due = await listRecoverableTeamInviteDeliveries(db, 25);
    let accepted = 0,
      deferred = 0,
      stopped = 0;
    for (const scope of due) {
      try {
        const result = await deliverTeamInvitation(db, scope);
        if (result.status === "accepted") accepted++;
        else if (result.status === "pending") deferred++;
        else stopped++;
      } catch {
        deferred++;
        this.logger.warn("Invitation delivery recovery deferred", {
          deliveryId: scope.deliveryId,
        });
      }
    }
    return { scanned: due.length, accepted, deferred, stopped };
  }
}
