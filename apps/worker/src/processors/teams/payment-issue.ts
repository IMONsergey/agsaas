import { EmailService } from "@midday/notifications/email-service";
import type { Job } from "bullmq";
import {
  type PaymentIssuePayload,
  paymentIssueSchema,
} from "../../schemas/teams";
import { getDb } from "../../utils/db";
import { NonRetryableError } from "../../utils/error-classification";
import { dispatchNotificationEmail } from "../../utils/notification-dispatch";
import { BaseProcessor } from "../base";

export class PaymentIssueProcessor extends BaseProcessor<PaymentIssuePayload> {
  async process(job: Job<PaymentIssuePayload>) {
    const parsed = paymentIssueSchema.safeParse(job.data);
    if (!parsed.success || !job.id)
      throw new NonRetryableError(
        "Invalid payment issue notification identity",
        undefined,
        "validation",
      );
    const payload = parsed.data;
    const db = getDb();
    const emailService = new EmailService(db);
    const result = await dispatchNotificationEmail({
      db,
      kind: "payment-issue",
      sourceJobId: job.id,
      payload,
      send: async () => ({
        type: "payment_issue",
        activities: 0,
        emails: await emailService.sendBulk(
          [
            {
              user: {
                id: "system",
                team_id: payload.teamId,
                email: payload.email,
              },
              to: payload.email,
              template: "payment-issue",
              subject: "Your payment didn't go through",
              data: { fullName: payload.fullName, teamName: payload.teamName },
            },
          ],
          "payment_issue",
        ),
      }),
    });
    this.logger.info("Payment issue email dispatch recorded", {
      jobId: job.id,
      teamId: payload.teamId,
      ...result,
    });
    return result;
  }
}
