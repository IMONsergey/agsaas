import { Notifications, type NotificationTypes } from "@midday/notifications";
import type { Job } from "bullmq";
import {
  type NotificationPayload,
  notificationPayloadSchema,
} from "../../schemas/notifications";
import { getDb } from "../../utils/db";
import { NonRetryableError } from "../../utils/error-classification";
import {
  dispatchNotificationEmail,
  type NotificationDispatchResult,
} from "../../utils/notification-dispatch";
import { sendToProviders } from "../../utils/provider-notifications";
import { BaseProcessor } from "../base";

/**
 * Unified Notification Processor
 *
 * Handles most notification types through a single processor.
 * Uses Zod discriminated union for type-safe payload handling.
 *
 * Notification types handled here:
 * - insight_ready: Weekly/monthly AI insights are ready
 * - inbox_new: New items in inbox from email/sync/slack/upload
 * - document_uploaded: Document uploaded to vault
 * - document_processed: Document processed and classified
 * - invoice_paid, invoice_overdue, invoice_cancelled, etc.: Invoice events
 * - recurring_series_completed, recurring_series_paused: Recurring invoice events
 *
 * Notification types handled by dedicated processors (invoices queue):
 * - invoice_sent: Handled by SendInvoiceEmailProcessor (needs PDF, token, status update)
 * - invoice_reminder_sent: Handled by SendInvoiceReminderProcessor (needs token, BCC logic)
 */
export class NotificationProcessor extends BaseProcessor<NotificationPayload> {
  async process(
    job: Job<NotificationPayload>,
  ): Promise<NotificationDispatchResult | void> {
    // Validate payload using Zod schema - fail fast on invalid data
    const parseResult = notificationPayloadSchema.safeParse(job.data);
    if (!parseResult.success) {
      this.logger.error("Invalid notification payload", {
        jobId: job.id,
        errors: parseResult.error.issues,
        data: job.data,
      });
      throw new Error(
        `Invalid notification payload: ${parseResult.error.message}`,
      );
    }

    const payload = parseResult.data;
    const db = getDb();
    const notifications = new Notifications(db);
    const deliver = <T extends keyof NotificationTypes>(
      type: T,
      data: Omit<NotificationTypes[T], "users">,
    ) => {
      if (!job.id)
        throw new NonRetryableError(
          "Notification email requires a stable job identity",
        );
      return dispatchNotificationEmail({
        db,
        kind: "notification",
        sourceJobId: job.id,
        payload,
        createActivities: async (activityOperationKey) =>
          (
            await notifications.create(type, payload.teamId, data, {
              sendEmail: false,
              activityOperationKey,
            })
          ).activities,
        send: () =>
          notifications.create(type, payload.teamId, data, {
            sendEmail: true,
            skipActivities: true,
          }),
      });
    };

    this.logger.info("Processing notification", {
      jobId: job.id,
      type: payload.type,
      teamId: payload.teamId,
    });

    // TypeScript automatically narrows the type based on the discriminant
    switch (payload.type) {
      // ========================================
      // Insight Notifications
      // ========================================
      case "insight_ready": {
        const result = await deliver("insight_ready", {
          insightId: payload.insightId,
          periodType: payload.periodType,
          periodLabel: payload.periodLabel,
          periodNumber: payload.periodNumber,
          periodYear: payload.periodYear,
          title: payload.title,
          audioUrl: payload.audioUrl,
        });

        this.logger.info("Insight ready email dispatch recorded", {
          insightId: payload.insightId,
          teamId: payload.teamId,
          periodLabel: payload.periodLabel,
          ...result,
        });
        return result;
      }

      // ========================================
      // Inbox Notifications
      // ========================================
      case "inbox_new": {
        await notifications.create(
          "inbox_new",
          payload.teamId,
          {
            totalCount: payload.totalCount,
            inboxType: payload.inboxType,
            source: payload.source,
            provider: payload.provider,
          },
          { sendEmail: false },
        );

        this.logger.info("Inbox new notification sent", {
          teamId: payload.teamId,
          totalCount: payload.totalCount,
          inboxType: payload.inboxType,
        });
        break;
      }

      // ========================================
      // Transaction Export Notifications
      // ========================================
      case "transactions_exported": {
        const result = await deliver("transactions_exported", {
          userEmail: payload.userEmail,
          transactionCount: payload.transactionCount,
          downloadLink: payload.downloadLink,
          accountantEmail: payload.accountantEmail,
          sendCopyToMe: payload.sendCopyToMe,
        });

        this.logger.info("Transactions exported email dispatch recorded", {
          teamId: payload.teamId,
          transactionCount: payload.transactionCount,
          sendCopyToMe: payload.sendCopyToMe,
          ...result,
        });
        return result;
      }

      // ========================================
      // Document Notifications
      // ========================================
      case "document_uploaded": {
        // Document uploaded is logged but typically doesn't need a notification
        this.logger.info("Document uploaded", {
          teamId: payload.teamId,
          fileName: payload.fileName,
        });
        break;
      }

      case "document_processed": {
        await notifications.create(
          "document_processed",
          payload.teamId,
          {
            fileName: payload.fileName,
            filePath: payload.filePath,
            mimeType: payload.mimeType,
          },
          { sendEmail: false },
        );

        this.logger.info("Document processed notification sent", {
          teamId: payload.teamId,
          fileName: payload.fileName,
        });
        break;
      }

      // ========================================
      // Invoice Notifications
      // ========================================
      case "invoice_paid": {
        const result = await deliver("invoice_paid", {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber,
          customerName: payload.customerName,
          paidAt: payload.paidAt,
          source: "system",
        });

        // A separate channel failure must never replay accepted email.
        if (!result.reused)
          await sendToProviders(db, payload.teamId, "invoice_paid", {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            customerName: payload.customerName,
            paidAt: payload.paidAt,
          }).catch(() =>
            this.logger.warn(
              "Secondary notification provider outcome unconfirmed",
              { dispatchId: result.dispatchId },
            ),
          );

        this.logger.info("Invoice paid email dispatch recorded", {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber,
          teamId: payload.teamId,
          ...result,
        });
        return result;
      }

      case "invoice_overdue": {
        const result = await deliver("invoice_overdue", {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber,
          customerName: payload.customerName || "Unknown",
          source: "system",
        });

        if (!result.reused)
          await sendToProviders(db, payload.teamId, "invoice_overdue", {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            customerName: payload.customerName || "Unknown",
          }).catch(() =>
            this.logger.warn(
              "Secondary notification provider outcome unconfirmed",
              { dispatchId: result.dispatchId },
            ),
          );

        this.logger.info("Invoice overdue email dispatch recorded", {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber,
          teamId: payload.teamId,
          ...result,
        });
        return result;
      }

      case "invoice_sent": {
        // Invoice sent emails are handled by SendInvoiceEmailProcessor in the invoices queue.
        // That processor fetches the full invoice (including token for payment link),
        // downloads PDF attachments, handles BCC logic, and updates invoice status.
        // If this case is triggered, it indicates a routing mistake.
        this.logger.warn(
          "invoice_sent should be routed to invoices queue (send-invoice-email job)",
          {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            teamId: payload.teamId,
          },
        );
        break;
      }

      case "invoice_cancelled": {
        await notifications.create(
          "invoice_cancelled",
          payload.teamId,
          {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            customerName: payload.customerName,
          },
          { sendEmail: false },
        );

        this.logger.info("Invoice cancelled notification created", {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber,
          teamId: payload.teamId,
        });
        break;
      }

      case "invoice_scheduled": {
        await notifications.create(
          "invoice_scheduled",
          payload.teamId,
          {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            scheduledAt: payload.scheduledAt,
            customerName: payload.customerName,
          },
          { sendEmail: false },
        );

        this.logger.info("Invoice scheduled notification created", {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber,
          teamId: payload.teamId,
          scheduledAt: payload.scheduledAt,
        });
        break;
      }

      case "invoice_reminder_sent": {
        // Invoice reminder emails are handled by SendInvoiceReminderProcessor in the invoices queue.
        // That processor fetches the full invoice (including token for payment link)
        // and handles BCC logic for billing emails.
        // If this case is triggered, it indicates a routing mistake.
        this.logger.warn(
          "invoice_reminder_sent should be routed to invoices queue (send-invoice-reminder job)",
          {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            teamId: payload.teamId,
          },
        );
        break;
      }

      case "invoice_refunded": {
        await notifications.create(
          "invoice_refunded",
          payload.teamId,
          {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            customerName: payload.customerName,
            refundedAt: payload.refundedAt,
          },
          { sendEmail: false },
        );

        this.logger.info("Invoice refunded notification created", {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber,
          teamId: payload.teamId,
        });
        break;
      }

      case "invoice_recurring_generated": {
        // Create in-app notification for recurring invoice generation
        // Note: The email is sent via the generate-invoice task, so we only do in-app here
        await notifications.create(
          "invoice_created",
          payload.teamId,
          {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            customerName: payload.customerName,
          },
          { sendEmail: false },
        );

        this.logger.info("Recurring invoice generated notification created", {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber,
          teamId: payload.teamId,
          sequence: payload.recurringSequence,
          totalCount: payload.recurringTotalCount,
        });
        break;
      }

      case "recurring_series_completed": {
        await notifications.create(
          "recurring_series_completed",
          payload.teamId,
          {
            invoiceId: payload.invoiceId,
            invoiceNumber: payload.invoiceNumber,
            customerName: payload.customerName,
            recurringId: payload.recurringId,
            totalGenerated: payload.totalGenerated,
          },
          { sendEmail: false },
        );

        this.logger.info("Recurring invoice series completed", {
          recurringId: payload.recurringId,
          teamId: payload.teamId,
          invoiceNumber: payload.invoiceNumber,
          customerName: payload.customerName,
          totalGenerated: payload.totalGenerated,
        });
        break;
      }

      case "recurring_series_paused": {
        await notifications.create(
          "recurring_series_paused",
          payload.teamId,
          {
            recurringId: payload.recurringId,
            customerName: payload.customerName,
            reason: "auto_failure",
            failureCount: 3,
          },
          { sendEmail: false },
        );

        this.logger.warn("Recurring invoice series paused due to errors", {
          recurringId: payload.recurringId,
          teamId: payload.teamId,
        });
        break;
      }

      default: {
        this.logger.warn("Unknown notification type", {
          type: (payload as { type: string }).type,
          teamId: (payload as { teamId: string }).teamId,
        });
      }
    }
  }
}
