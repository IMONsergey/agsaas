import { listRecoverableInvoiceEmailDeliveries } from "@midday/db/queries";
import { Notifications } from "@midday/notifications";
import type { Job } from "bullmq";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";

/** Redis can lose a job without losing its SQL receipt. Recover only persisted operations. */
export class ReconcileInvoiceDeliveriesProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job<Record<string, never>>) {
    const db = getDb();
    const pending = await listRecoverableInvoiceEmailDeliveries(db, 25);
    const notifications = new Notifications(db);
    let completed = 0;
    let deferred = 0;
    for (const scope of pending) {
      try {
        await notifications.reconcileInvoiceDelivery(scope);
        completed += 1;
      } catch (error) {
        deferred += 1;
        // Do not log provider payloads, recipients or raw DB error details.
        this.logger.warn("Invoice delivery recovery deferred", {
          invoiceId: scope.invoiceId,
          operationKey: scope.operationKey,
          stopped:
            error instanceof Error &&
            error.name === "InvoiceDeliveryStoppedError",
        });
      }
    }
    return { scanned: pending.length, completed, deferred };
  }
}
