import { listRecoverableNotificationDispatches } from "@midday/db/queries/notification-dispatches";
import type { Job } from "bullmq";
import { notificationPayloadSchema } from "../../schemas/notifications";
import { paymentIssueSchema } from "../../schemas/teams";
import { getDb } from "../../utils/db";
import { NotificationDispatchPendingError } from "../../utils/notification-dispatch";
import {
  deliverUpcomingNotification,
  upcomingNotificationDispatchSchema,
} from "../../utils/upcoming-notification-delivery";
import { BaseProcessor } from "../base";
import { PaymentIssueProcessor } from "../teams/payment-issue";
import { NotificationProcessor } from "./notification";

/** SQL recovery survives Redis retention/loss. Original payload and identity
 * are reused; an expired dispatch fence stops instead of resending mail. */
export class ReconcileNotificationDispatchesProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job<Record<string, never>>) {
    const pending = await listRecoverableNotificationDispatches(getDb(), 25);
    let completed = 0;
    let deferred = 0;
    let stopped = 0;
    for (const row of pending) {
      try {
        if (!row.payload || row.payload.teamId !== row.teamId)
          throw new Error("Invalid persisted notification scope");
        if (row.kind === "notification") {
          const data = notificationPayloadSchema.parse(row.payload);
          await new NotificationProcessor().process({
            id: row.sourceJobId,
            data,
          } as Job<typeof data>);
        } else if (row.kind === "payment-issue") {
          const data = paymentIssueSchema.parse(row.payload);
          await new PaymentIssueProcessor().process({
            id: row.sourceJobId,
            data,
          } as Job<typeof data>);
        } else if (row.kind === "recurring-upcoming") {
          await deliverUpcomingNotification(
            getDb(),
            upcomingNotificationDispatchSchema.parse(row.payload),
          );
        } else throw new Error("Unknown persisted notification kind");
        completed += 1;
      } catch (error) {
        if (error instanceof NotificationDispatchPendingError) deferred += 1;
        else stopped += 1;
        this.logger.warn("Notification email recovery incomplete", {
          dispatchId: row.id,
          deferred: error instanceof NotificationDispatchPendingError,
        });
      }
    }
    return { scanned: pending.length, completed, deferred, stopped };
  }
}
