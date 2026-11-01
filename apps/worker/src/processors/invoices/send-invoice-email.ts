import {
  canSendInvoiceEmail,
  getInvoiceById,
  isCurrentInvoiceSchedule,
  recordInvoiceEmailAccepted,
} from "@midday/db/queries";
import { Notifications } from "@midday/notifications";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import type { SendInvoiceEmailPayload } from "../../schemas/invoices";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";
import { deliverInvoiceEmail } from "./invoice-email-delivery";

/**
 * Send Invoice Email Processor
 * Handles sending the invoice email with optional PDF attachment
 */
export class SendInvoiceEmailProcessor extends BaseProcessor<SendInvoiceEmailPayload> {
  async process(job: Job<SendInvoiceEmailPayload>): Promise<void> {
    const { invoiceId, filename, fullPath, expectedScheduledJobId } = job.data;
    const db = getDb();

    this.logger.info("Starting send invoice email", {
      jobId: job.id,
      invoiceId,
      filename,
    });

    // Fetch invoice with related data
    const invoice = await getInvoiceById(db, { id: invoiceId });

    if (!invoice) {
      this.logger.error("Invoice not found", { invoiceId });
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    if (!canSendInvoiceEmail(invoice.status)) {
      this.logger.info("Skipping invoice email for terminal invoice", {
        invoiceId,
        status: invoice.status,
      });
      return;
    }

    if (
      expectedScheduledJobId !== undefined &&
      !isCurrentInvoiceSchedule(invoice, expectedScheduledJobId)
    ) {
      this.logger.info("Skipping email for a superseded invoice schedule", {
        invoiceId,
      });
      return;
    }

    let attachments: { content: string; filename: string }[] | undefined;

    // Download PDF attachment if template includes PDF
    const template = invoice.template as Record<string, unknown> | null;
    if (template?.includePdf) {
      // No storage/provider client is constructed for an already terminal job.
      const supabase = createClient();
      const { data: attachmentData } = await supabase.storage
        .from("vault")
        .download(fullPath);

      if (attachmentData) {
        attachments = [
          {
            content: Buffer.from(await attachmentData.arrayBuffer()).toString(
              "base64",
            ),
            filename,
          },
        ];
        this.logger.debug("PDF attachment prepared", { invoiceId });
      }

      // Preparing an attachment may take time. Recheck before sending; payments
      // during the subsequent provider call are handled by the atomic write.
      const current = await getInvoiceById(db, {
        id: invoiceId,
        teamId: invoice.teamId,
      });
      if (
        !current ||
        !canSendInvoiceEmail(current.status) ||
        (expectedScheduledJobId !== undefined &&
          !isCurrentInvoiceSchedule(current, expectedScheduledJobId))
      ) {
        this.logger.info(
          "Skipping invoice email after attachment preparation",
          {
            invoiceId,
            status: current?.status,
          },
        );
        return;
      }
    }

    const customerEmail = invoice.customer?.email;
    const customerName = invoice.customer?.name;
    const invoiceNumber = invoice.invoiceNumber;
    const userEmail = invoice.user?.email;
    const shouldSendCopy = template?.sendCopy;

    // Parse billing emails (supports comma-separated list)
    const billingEmails = invoice.customer?.billingEmail
      ? invoice.customer.billingEmail
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
      : [];

    // Build BCC list
    const bcc = [
      ...billingEmails,
      ...(shouldSendCopy && userEmail ? [userEmail] : []),
    ];

    if (!customerEmail) {
      this.logger.error("Invoice customer email not found", { invoiceId });
      throw new Error(`Invoice customer email not found: ${invoiceId}`);
    }

    if (!invoiceNumber || !customerName) {
      this.logger.error("Invoice missing required fields", {
        invoiceId,
        hasInvoiceNumber: !!invoiceNumber,
        hasCustomerName: !!customerName,
      });
      throw new Error(`Invoice missing required fields: ${invoiceId}`);
    }

    const notifications = new Notifications(db);
    await deliverInvoiceEmail(
      () =>
        notifications.create(
          "invoice_sent",
          invoice.teamId,
          {
            invoiceId,
            invoiceNumber,
            customerName,
            customerEmail,
            token: invoice.token,
            // Gmail structured data fields
            amount: invoice.amount ?? undefined,
            currency: invoice.currency ?? undefined,
            dueDate: invoice.dueDate ?? undefined,
            // Custom email content from template
            emailSubject: (template?.emailSubject as string) ?? undefined,
            emailHeading: (template?.emailHeading as string) ?? undefined,
            emailBody: (template?.emailBody as string) ?? undefined,
            emailButtonText: (template?.emailButtonText as string) ?? undefined,
            // Template labels and logo
            logoUrl: (template?.logoUrl as string) ?? undefined,
            dueDateLabel: (template?.dueDateLabel as string) ?? undefined,
            invoiceNoLabel: (template?.invoiceNoLabel as string) ?? undefined,
            // Formatting
            locale: (template?.locale as string) ?? undefined,
            dateFormat: (template?.dateFormat as string) ?? undefined,
          },
          {
            sendEmail: true,
            requireEmailAcceptance: true,
            bcc,
            attachments,
            replyTo: invoice.team?.email ?? undefined,
          },
        ),
      (acceptedAt) =>
        recordInvoiceEmailAccepted(db, {
          invoiceId,
          teamId: invoice.teamId,
          recipient: customerEmail,
          acceptedAt,
          ...(expectedScheduledJobId === undefined
            ? {}
            : { expectedScheduledJobId }),
        }),
    );

    this.logger.info("Invoice email accepted by provider and recorded", {
      invoiceId,
    });
  }
}
