import {
  canSendInvoiceEmail,
  deferInvoiceEmailFinalization,
  finalizeInvoiceEmailDelivery,
  getInvoiceById,
  getInvoiceEmailDelivery,
  INVOICE_EMAIL_ENVELOPE_MAX_BYTES,
  isCurrentInvoiceSchedule,
  recordInvoiceEmailAccepted,
} from "@midday/db/queries";
import { Notifications } from "@midday/notifications";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import type { SendInvoiceEmailPayload } from "../../schemas/invoices";
import { getDb } from "../../utils/db";
import { NonRetryableError } from "../../utils/error-classification";
import { BaseProcessor } from "../base";
import { invoiceDeliveryOperationKey } from "./invoice-delivery-operation";
import { deliverInvoiceEmail } from "./invoice-email-delivery";

/**
 * Send Invoice Email Processor
 * Handles sending the invoice email with optional PDF attachment
 */
export class SendInvoiceEmailProcessor extends BaseProcessor<SendInvoiceEmailPayload> {
  async process(job: Job<SendInvoiceEmailPayload>): Promise<void> {
    const {
      invoiceId,
      filename,
      fullPath,
      expectedScheduledJobId,
      deliveryKey,
    } = job.data;
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

    const operationKey = invoiceDeliveryOperationKey({
      teamId: invoice.teamId,
      invoiceId,
      kind: "invoice",
      job,
      expectedScheduledJobId,
      deliveryKey,
    });
    const scope = { teamId: invoice.teamId, invoiceId, operationKey };
    const receipt = await getInvoiceEmailDelivery(db, scope);
    if (receipt?.status === "accepted" || receipt?.status === "completed") {
      // Known acceptance must be finalized even if the invoice has since been paid.
      try {
        const finalized = await finalizeInvoiceEmailDelivery(db, scope);
        if (finalized?.status !== "completed")
          throw new Error("Receipt disappeared");
      } catch {
        try {
          await deferInvoiceEmailFinalization(db, scope);
        } catch {
          /* Keep errors free of SQL payloads. */
        }
        throw new Error("Invoice receipt finalization temporarily unavailable");
      }
      return;
    }
    if (receipt) {
      // A retry resumes the frozen bytes, not current Storage/template/customer
      // data. The DB claim rechecks the current status and schedule version.
      const notifications = new Notifications(db);
      await deliverInvoiceEmail(
        () => notifications.reconcileInvoiceDelivery(scope),
        async () => {
          throw new Error("Durable recovery must finalize its own receipt");
        },
      );
      return;
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
      const { data: attachmentData, error: attachmentError } =
        await supabase.storage.from("vault").download(fullPath);

      if (attachmentError || !attachmentData)
        throw new Error("Invoice PDF download failed before email preparation");
      if (
        attachmentData.size > Math.floor(INVOICE_EMAIL_ENVELOPE_MAX_BYTES * 0.7)
      ) {
        throw new NonRetryableError(
          "Invoice PDF exceeds the durable envelope size limit",
        );
      }

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
            invoiceDelivery: {
              invoiceId,
              operationKey,
              expectedScheduledJobId,
            },
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
