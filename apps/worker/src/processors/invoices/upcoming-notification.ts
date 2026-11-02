import { sendToProviders } from "@midday/bot";
import { getUpcomingDueRecurring } from "@midday/db/queries";
import type { Job } from "bullmq";
import type { InvoiceUpcomingNotificationPayload } from "../../schemas/invoices";
import { getDb } from "../../utils/db";
import { isStaging } from "../../utils/env";
import { deliverUpcomingNotification } from "../../utils/upcoming-notification-delivery";
import { BaseProcessor } from "../base";

type ProcessResult = {
  processed: number;
  skipped: number;
  failed: number;
  errors: Array<{ teamId: string; error: string }>;
  hasMore: boolean;
};

/** One stable intent per recurring occurrence. Batch membership changes and
 * marker-write retries must never send accepted recipients a second time. */
export class InvoiceUpcomingNotificationProcessor extends BaseProcessor<InvoiceUpcomingNotificationPayload> {
  async process(
    _job: Job<InvoiceUpcomingNotificationPayload>,
  ): Promise<ProcessResult> {
    if (process.env.DISABLE_UPCOMING_NOTIFICATIONS === "true") {
      return {
        processed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        hasMore: false,
      };
    }
    const db = getDb();
    const { data: upcoming, hasMore } = await getUpcomingDueRecurring(db, 24);
    if (isStaging()) {
      this.logger.info("Upcoming notification preview only", {
        occurrences: upcoming.length,
      });
      return {
        processed: 0,
        skipped: upcoming.length,
        failed: 0,
        errors: [],
        hasMore,
      };
    }
    const errors: ProcessResult["errors"] = [];
    let processed = 0;
    let skipped = 0;
    for (const invoice of upcoming) {
      if (!invoice.nextScheduledAt) {
        skipped++;
        continue;
      }
      try {
        const result = await deliverUpcomingNotification(db, {
          teamId: invoice.teamId,
          recurringId: invoice.id,
          nextScheduledAt: invoice.nextScheduledAt,
        });
        if (!result.reused) {
          await sendToProviders(
            db,
            invoice.teamId,
            "recurring_invoice_upcoming",
            {
              invoices: [
                {
                  recurringId: invoice.id,
                  customerName: invoice.customerName ?? undefined,
                  amount: invoice.amount ?? undefined,
                  currency: invoice.currency ?? undefined,
                  scheduledAt: invoice.nextScheduledAt,
                  frequency: invoice.frequency,
                },
              ],
              count: 1,
            },
          ).catch(() =>
            this.logger.warn(
              "Secondary upcoming notification outcome unconfirmed",
              { dispatchId: result.dispatchId },
            ),
          );
        }
        this.logger.info("Upcoming invoice email dispatch recorded", {
          recurringId: invoice.id,
          ...result,
        });
        processed++;
      } catch {
        errors.push({
          teamId: invoice.teamId,
          error:
            "Upcoming notification incomplete; inspect notification delivery status",
        });
      }
    }
    return { processed, skipped, failed: errors.length, errors, hasMore };
  }
}
