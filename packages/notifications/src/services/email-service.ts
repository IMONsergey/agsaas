import type { Database } from "@midday/db/client";
import { shouldSendNotification } from "@midday/db/queries";
import {
  getProductEmailConfig,
  isProductEmailTransportAvailable,
  requireProductEmailTransport,
} from "@midday/email/config";
import InsightsWeeklyEmail from "@midday/email/emails/insights-weekly";
import InvoiceEmail from "@midday/email/emails/invoice";
import InvoiceOverdueEmail from "@midday/email/emails/invoice-overdue";
import InvoicePaidEmail from "@midday/email/emails/invoice-paid";
import InvoiceReminderEmail from "@midday/email/emails/invoice-reminder";
import { PaymentIssueEmail } from "@midday/email/emails/payment-issue";
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

export type InvoiceEnvelopeOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "retry" | "rejected" | "reconciliation"; code: string };

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
  private client?: Resend;
  private clientKey?: string;
  private readonly suppliedClient: boolean;

  constructor(
    private db: Database,
    client?: Resend,
  ) {
    this.client = client;
    this.suppliedClient = client !== undefined;
  }

  /** Transport-only preflight: frozen bodies must not depend on new identity
   * settings, and accepted receipts can finalize without any provider. */
  canSend(): boolean {
    return this.suppliedClient || isProductEmailTransportAvailable();
  }

  #provider(): Resend {
    if (this.suppliedClient) return this.client!;
    const key = requireProductEmailTransport();
    if (!this.client || this.clientKey !== key) {
      this.client = new Resend(key);
      this.clientKey = key;
    }
    return this.client;
  }

  /** Fully rendered provider wire body; no React/template work occurs on replay. */
  async prepareInvoiceEnvelope(email: EmailInput): Promise<string> {
    const payload = await this.#buildEmailPayload(email);
    const attachments = payload.attachments?.map((attachment) => {
      // URLs and mutable Storage paths are not an immutable envelope.
      if (attachment.path || typeof attachment.content !== "string") {
        throw new Error("Invoice attachments must contain frozen base64 bytes");
      }
      return {
        content: attachment.content,
        filename: attachment.filename,
        content_type: attachment.contentType,
        content_id: attachment.contentId,
      };
    });
    return JSON.stringify({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      headers: payload.headers,
      reply_to: payload.replyTo,
      cc: payload.cc,
      bcc: payload.bcc,
      tags: payload.tags,
      attachments,
    });
  }

  async sendInvoiceEnvelope(
    envelope: string,
    idempotencyKey: string,
  ): Promise<InvoiceEnvelopeOutcome> {
    if (!this.canSend())
      return { kind: "retry", code: "configuration_unavailable" };
    const body: unknown = JSON.parse(envelope);
    try {
      // Public SDK post() preserves this already-rendered wire body. The
      // timeout is passed through by the pinned SDK; it does not prove rejection.
      const options = { idempotencyKey, signal: AbortSignal.timeout(30_000) };
      const response = await this.#provider().post<{ id: string }>(
        "/emails",
        body,
        options,
      );
      if (response.error) {
        const { statusCode: status, name } = response.error;
        if (status === 409 && name === "invalid_idempotent_request")
          return { kind: "reconciliation", code: "provider_payload_conflict" };
        if (status === 409 && name === "concurrent_idempotent_requests")
          return { kind: "retry", code: "provider_concurrent" };
        if (status === 429)
          return { kind: "retry", code: "provider_rate_limit" };
        if (
          typeof status === "number" &&
          status >= 400 &&
          status < 500 &&
          status !== 408
        )
          return { kind: "rejected", code: "provider_rejected" };
        return { kind: "retry", code: "provider_uncertain" };
      }
      if (
        typeof response.data?.id !== "string" ||
        !response.data.id.trim() ||
        response.data.id.length > 256
      )
        return { kind: "retry", code: "provider_uncertain" };
      return { kind: "accepted", messageId: response.data.id };
    } catch {
      return { kind: "retry", code: "provider_uncertain" };
    }
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
    if (!this.canSend()) {
      return {
        ...result,
        failed: eligibleEmails.length,
        reason: "configuration_unavailable",
      };
    }
    let emailPayloads: CreateEmailOptions[];
    try {
      getProductEmailConfig();
    } catch {
      return {
        ...result,
        failed: eligibleEmails.length,
        reason: "configuration_unavailable",
      };
    }
    try {
      // Render the complete batch before making the first external request.
      emailPayloads = await Promise.all(
        eligibleEmails.map((email) => this.#buildEmailPayload(email)),
      );
    } catch {
      // No request was made. This is a local configuration/template error,
      // not evidence of acceptance and not a transient provider rejection.
      return {
        ...result,
        failed: eligibleEmails.length,
        reason: "preparation_failed",
      };
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
          const response = await this.#provider().emails.send(payload);
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
        const response = await this.#provider().batch.send(emailPayloads);
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
    const config = getProductEmailConfig();
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
      // Per-handler/runtime options cannot impersonate another sending domain.
      from: config.from,
      to: recipients,
      subject: email.subject,
      html,
      headers: {
        "X-Entity-Ref-ID": nanoid(),
        ...email.headers,
      },
    };

    // Add optional fields if present
    if (email.replyTo || config.replyTo)
      payload.replyTo = email.replyTo || config.replyTo;
    if (email.cc) payload.cc = email.cc;
    if (email.bcc) payload.bcc = email.bcc;
    if (email.attachments) payload.attachments = email.attachments;
    if (email.tags) payload.tags = email.tags;
    if (email.text) payload.text = email.text;

    return payload;
  }

  #getTemplate(templateName: string) {
    const templates = {
      "payment-issue": PaymentIssueEmail,
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
