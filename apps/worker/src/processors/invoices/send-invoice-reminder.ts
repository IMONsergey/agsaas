import {
  canSendInvoiceReminder,
  deferInvoiceEmailFinalization,
  finalizeInvoiceEmailDelivery,
  getInvoiceDocumentById,
  getInvoiceEmailDelivery,
  recordInvoiceReminderAccepted,
} from "@midday/db/queries";
import { Notifications } from "@midday/notifications";
import type { Job } from "bullmq";
import type { SendInvoiceReminderPayload } from "../../schemas/invoices";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";
import { invoiceDeliveryOperationKey } from "./invoice-delivery-operation";
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
    const invoice = await getInvoiceDocumentById(db, { id: invoiceId });

    if (!invoice) {
      this.logger.error("Invoice not found", { invoiceId });
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    const operationKey = invoiceDeliveryOperationKey({
      teamId: invoice.teamId,
      invoiceId,
      kind: "reminder",
      job,
    });
    const scope = { teamId: invoice.teamId, invoiceId, operationKey };
    const receipt = await getInvoiceEmailDelivery(db, scope);
    if (receipt?.status === "accepted" || receipt?.status === "completed") {
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
      const notifications = new Notifications(db);
      await deliverInvoiceEmail(
        () => notifications.reconcileInvoiceDelivery(scope),
        async () => {
          throw new Error("Durable recovery must finalize its own receipt");
        },
      );
      return;
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
            invoiceDelivery: { invoiceId, operationKey },
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
