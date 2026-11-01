import {
  canSendInvoiceReminder,
  getInvoiceById,
  recordInvoiceReminderAccepted,
} from "@midday/db/queries";
import { Notifications } from "@midday/notifications";
import type { Job } from "bullmq";
import type { SendInvoiceReminderPayload } from "../../schemas/invoices";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";
import { deliverInvoiceEmail } from "./invoice-email-delivery";

/**
 * Send Invoice Reminder Processor
 * Handles sending reminder emails for unpaid/overdue invoices
 */
export class SendInvoiceReminderProcessor extends BaseProcessor<SendInvoiceReminderPayload> {
  async process(job: Job<SendInvoiceReminderPayload>): Promise<void> {
    const { invoiceId } = job.data;
    const db = getDb();

    this.logger.info("Starting send invoice reminder", {
      jobId: job.id,
      invoiceId,
    });

    // Fetch invoice with related data
    const invoice = await getInvoiceById(db, { id: invoiceId });

    if (!invoice) {
      this.logger.error("Invoice not found", { invoiceId });
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    if (!canSendInvoiceReminder(invoice.status)) {
      this.logger.info(
        "Skipping reminder for invoice that is not outstanding",
        {
          invoiceId,
          status: invoice.status,
        },
      );
      return;
    }

    const customerEmail = invoice.customer?.email;
    const customerName = invoice.customer?.name;
    const invoiceNumber = invoice.invoiceNumber;

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
          "invoice_reminder_sent",
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
          },
          {
            sendEmail: true,
            requireEmailAcceptance: true,
            replyTo: invoice.team?.email ?? undefined,
          },
        ),
      (acceptedAt) =>
        recordInvoiceReminderAccepted(db, {
          invoiceId,
          teamId: invoice.teamId,
          acceptedAt,
        }),
    );

    this.logger.info("Invoice reminder accepted by provider and recorded", {
      invoiceId,
    });
  }
}
