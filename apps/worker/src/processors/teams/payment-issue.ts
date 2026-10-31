import { PaymentIssueEmail } from "@midday/email/emails/payment-issue";
import { render } from "@midday/email/render";
import type { Job } from "bullmq";
import { Resend } from "resend";
import type { PaymentIssuePayload } from "../../schemas/teams";
import { BaseProcessor } from "../base";

let resend: Resend | undefined;

function getResend(): Resend {
  // Email credentials are only required when this processor sends an email,
  // not when the worker imports its registry to start unrelated queues.
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY!);
  return resend;
}

export class PaymentIssueProcessor extends BaseProcessor<PaymentIssuePayload> {
  async process(job: Job<PaymentIssuePayload>): Promise<void> {
    const { teamId, email, fullName, teamName } = job.data;
    const resend = getResend();

    this.logger.info("Sending payment issue email", {
      jobId: job.id,
      teamId,
      email,
    });

    const html = await render(PaymentIssueEmail({ fullName, teamName }));

    await resend.emails.send({
      from: "Middaybot <middaybot@midday.ai>",
      replyTo: "pontus@midday.ai",
      to: email,
      subject: "Your payment didn't go through",
      html,
    });

    this.logger.info("Payment issue email sent", {
      jobId: job.id,
      teamId,
    });
  }
}
