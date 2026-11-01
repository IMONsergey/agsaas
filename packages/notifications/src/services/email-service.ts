import type { Database } from "@midday/db/client";
import { shouldSendNotification } from "@midday/db/queries";
import InsightsWeeklyEmail from "@midday/email/emails/insights-weekly";
import InvoiceEmail from "@midday/email/emails/invoice";
import InvoiceOverdueEmail from "@midday/email/emails/invoice-overdue";
import InvoicePaidEmail from "@midday/email/emails/invoice-paid";
import InvoiceReminderEmail from "@midday/email/emails/invoice-reminder";
import TransactionsEmail from "@midday/email/emails/transactions";
import TransactionsExportedEmail from "@midday/email/emails/transactions-exported";
import UpcomingInvoicesEmail from "@midday/email/emails/upcoming-invoices";
import { render } from "@midday/email/render";
import { nanoid } from "nanoid";
import { type CreateEmailOptions, type ErrorResponse, Resend } from "resend";
import type { EmailInput } from "../base";
import {
  type EmailDeliveryResult,
  emptyEmailDeliveryResult,
} from "./email-delivery-result";

function providerRejection(
  error: ErrorResponse,
  count: number,
): Pick<EmailDeliveryResult, "failed" | "uncertain" | "retryable"> {
  // Resend 6.x resolves network/JSON failures as application_error with a null
  // statusCode. Treating every resolved error as a rejection would resend mail
  // that the provider may already have accepted.
  const status = error.statusCode;
  // A timeout or 5xx may originate after acceptance (including from a proxy).
  // Without a durable, identical idempotent envelope it is not safe to resend.
  const confirmedRejection =
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408;
  return {
    failed: count,
    uncertain: confirmedRejection ? 0 : count,
    retryable: confirmedRejection && status === 429,
  };
}

export class EmailService {
  private client: Resend;

  constructor(
    private db: Database,
    client?: Resend,
  ) {
    this.client = client ?? new Resend(process.env.RESEND_API_KEY!);
  }

  async sendBulk(
    emails: EmailInput[],
    notificationType: string,
  ): Promise<EmailDeliveryResult> {
    if (emails.length === 0) {
      return emptyEmailDeliveryResult();
    }

    const eligibleEmails = await this.#filterEligibleEmails(
      emails,
      notificationType,
    );

    if (eligibleEmails.length === 0) {
      return emptyEmailDeliveryResult(emails.length);
    }

    const result = emptyEmailDeliveryResult(
      emails.length - eligibleEmails.length,
    );
    let emailPayloads: CreateEmailOptions[];
    try {
      // Render the complete batch before making the first external request.
      emailPayloads = await Promise.all(
        eligibleEmails.map((email) => this.#buildEmailPayload(email)),
      );
    } catch {
      // No request was made. This is a local configuration/template error,
      // not evidence of acceptance and not a transient provider rejection.
      return { ...result, failed: eligibleEmails.length };
    }

    const hasAttachments = emailPayloads.some(
      (payload) => payload.attachments && payload.attachments.length > 0,
    );
    let allFailuresRetryable = true;

    if (hasAttachments) {
      // Keep independent outcomes: one failed recipient must not erase an
      // earlier acceptance, or cause a blanket retry of accepted envelopes.
      for (const payload of emailPayloads) {
        try {
          const response = await this.client.emails.send(payload);
          if (response.error) {
            const rejection = providerRejection(response.error, 1);
            result.failed += rejection.failed;
            result.uncertain += rejection.uncertain;
            allFailuresRetryable &&= rejection.retryable;
          } else if (response.data?.id?.trim()) {
            result.sent += 1;
            result.providerMessageIds.push(response.data.id);
            result.acceptedAt = new Date().toISOString();
          } else {
            result.failed += 1;
            result.uncertain += 1;
          }
        } catch {
          result.failed += 1;
          result.uncertain += 1;
        }
      }
    } else {
      try {
        const response = await this.client.batch.send(emailPayloads);
        if (response.error) {
          const rejection = providerRejection(
            response.error,
            eligibleEmails.length,
          );
          result.failed = rejection.failed;
          result.uncertain = rejection.uncertain;
          allFailuresRetryable = rejection.retryable;
        } else {
          const acceptedIds = Array.isArray(response.data?.data)
            ? response.data.data
                .map((email) => email?.id)
                .filter((id) => typeof id === "string" && id.trim().length > 0)
            : [];
          const uniqueIds = [...new Set(acceptedIds)];
          // Strict batch validation is the SDK default. A malformed/partial
          // acknowledgement is not permission to pretend the rest were sent.
          if (uniqueIds.length <= eligibleEmails.length) {
            result.sent = uniqueIds.length;
            result.providerMessageIds = uniqueIds;
            if (uniqueIds.length > 0) {
              result.acceptedAt = new Date().toISOString();
            }
          }
          result.failed = eligibleEmails.length - result.sent;
          result.uncertain = result.failed;
        }
      } catch {
        result.failed = eligibleEmails.length;
        result.uncertain = eligibleEmails.length;
      }
    }

    result.retryable =
      result.sent === 0 &&
      result.failed > 0 &&
      result.uncertain === 0 &&
      result.skipped === 0 &&
      allFailuresRetryable;
    return result;
  }

  async #filterEligibleEmails(emails: EmailInput[], notificationType: string) {
    const eligibleEmails = await Promise.all(
      emails.map(async (email) => {
        // For customer emails (with explicit 'to' field), always send - decision made at notification level
        if (email.to && email.to.length > 0) {
          return email;
        }

        // For team emails (no 'to' field), check user's notification settings
        const shouldSend = await shouldSendNotification(
          this.db,
          email.user.id,
          email.user.team_id,
          notificationType,
          "email",
        );

        return shouldSend ? email : null;
      }),
    );

    return eligibleEmails.filter(Boolean) as EmailInput[];
  }

  async #buildEmailPayload(email: EmailInput): Promise<CreateEmailOptions> {
    let html: string;
    if (email.template) {
      const template = this.#getTemplate(email.template as string);
      html = await render(template(email.data as any));
    } else {
      throw new Error(`No template found for email: ${email.template}`);
    }

    if (!email.subject) {
      throw new Error(`No subject found for email: ${email.template}`);
    }

    // Use explicit 'to' field if provided, otherwise default to user email
    const recipients = email.to || [email.user.email];

    const payload: CreateEmailOptions = {
      from: email.from || "Midday <middaybot@midday.ai>",
      to: recipients,
      subject: email.subject,
      html,
      headers: {
        "X-Entity-Ref-ID": nanoid(),
        ...email.headers,
      },
    };

    // Add optional fields if present
    if (email.replyTo) payload.replyTo = email.replyTo;
    if (email.cc) payload.cc = email.cc;
    if (email.bcc) payload.bcc = email.bcc;
    if (email.attachments) payload.attachments = email.attachments;
    if (email.tags) payload.tags = email.tags;
    if (email.text) payload.text = email.text;

    return payload;
  }

  #getTemplate(templateName: string) {
    const templates = {
      "invoice-overdue": InvoiceOverdueEmail,
      "invoice-paid": InvoicePaidEmail,
      invoice: InvoiceEmail,
      "invoice-reminder": InvoiceReminderEmail,
      transactions: TransactionsEmail,
      "transactions-exported": TransactionsExportedEmail,
      "upcoming-invoices": UpcomingInvoicesEmail,
      "insights-weekly": InsightsWeeklyEmail,
    };

    const template = templates[templateName as keyof typeof templates];

    if (!template) {
      throw new Error(`Unknown email template: ${templateName}`);
    }

    return template;
  }
}
