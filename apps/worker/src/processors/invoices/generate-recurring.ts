import { financialJobOperationKey } from "@midday/db/financial-job";
import {
  checkInvoiceExists,
  draftInvoice,
  getCustomerById,
  getDueInvoiceRecurring,
  getNextInvoiceNumber,
  lockDueInvoiceRecurring,
  markInvoiceGenerated,
  recordInvoiceGenerationFailure,
  updateInvoice,
} from "@midday/db/queries";
import { ensureFinancialJobDispatch } from "@midday/db/queries/financial-job-dispatches";
import { getStartOfDayUTC } from "@midday/invoice/recurring";
import { generateToken } from "@midday/invoice/token";
import { transformCustomerToContent } from "@midday/invoice/utils";
import type { Job } from "bullmq";
import { addDays } from "date-fns";
import { v4 as uuidv4 } from "uuid";
import {
  RecurringInvoiceError,
  RecurringInvoiceErrors,
} from "../../errors/invoice-errors";
import type { InvoiceRecurringSchedulerPayload } from "../../schemas/invoices";
import { getDb } from "../../utils/db";
import { withDbConnectionRetry } from "../../utils/db-retry";
import { isStaging } from "../../utils/env";
import {
  buildInvoiceTemplateFromRecurring,
  parseLineItems,
  stringifyJsonField,
  validateRecurringDataIntegrity,
} from "../../utils/invoice-template-builder";
import { BaseProcessor } from "../base";

type GeneratedInvoiceResult = {
  invoiceId: string;
  invoiceNumber: string;
  recurringId: string;
  sequence: number;
};

type ProcessResult = {
  processed: number;
  skipped: number;
  failed: number;
  results: GeneratedInvoiceResult[];
  errors: Array<{ recurringId: string; error: string }>;
  hasMore: boolean;
};

/**
 * Scheduled processor that generates invoices from recurring invoice series
 * Runs every 2 hours to find and process due recurring invoices
 *
 * Duplicate processing is prevented by:
 * 1. A SQL row lock and expected sequence/date fence per recurring series
 * 2. Invoice, queue intents and advancement commit in the same transaction
 *
 * Kill switch: Set DISABLE_RECURRING_INVOICES=true to disable processing
 */
export class InvoiceRecurringSchedulerProcessor extends BaseProcessor<InvoiceRecurringSchedulerPayload> {
  async process(
    _job: Job<InvoiceRecurringSchedulerPayload>,
  ): Promise<ProcessResult> {
    // Kill switch - can be toggled without deploy via environment variable
    if (process.env.DISABLE_RECURRING_INVOICES === "true") {
      this.logger.warn(
        "Recurring invoice scheduler disabled via DISABLE_RECURRING_INVOICES",
      );
      return {
        processed: 0,
        skipped: 0,
        failed: 0,
        results: [],
        errors: [],
        hasMore: false,
      };
    }

    const db = getDb();

    // In staging, log what would happen but don't execute
    if (isStaging()) {
      this.logger.info(
        "[STAGING MODE] Recurring invoice scheduler - logging only, no execution",
      );

      const { data: dueRecurring, hasMore } = await withDbConnectionRetry(
        () => getDueInvoiceRecurring(db),
        {
          operationName: "getDueInvoiceRecurring(staging)",
          logger: this.logger,
        },
      );

      if (dueRecurring.length === 0) {
        this.logger.info("[STAGING] No recurring invoices due for generation");
        return {
          processed: 0,
          skipped: 0,
          failed: 0,
          results: [],
          errors: [],
          hasMore: false,
        };
      }

      this.logger.info(
        `[STAGING] Would process ${dueRecurring.length} recurring invoices${hasMore ? " (more pending)" : ""}`,
        {
          count: dueRecurring.length,
          hasMore,
          recurringInvoices: dueRecurring.map((r) => ({
            id: r.id,
            teamId: r.teamId,
            customerName: r.customerName,
            nextScheduledAt: r.nextScheduledAt,
            sequence: r.invoicesGenerated + 1,
            amount: r.amount,
            currency: r.currency,
          })),
        },
      );

      // Return simulated results
      return {
        processed: dueRecurring.length,
        skipped: 0,
        failed: 0,
        results: dueRecurring.map((r) => ({
          invoiceId: `[STAGING-SIMULATED-${r.id.slice(0, 8)}]`,
          invoiceNumber: `[STAGING-SIM-${r.invoicesGenerated + 1}]`,
          recurringId: r.id,
          sequence: r.invoicesGenerated + 1,
        })),
        errors: [],
        hasMore,
      };
    }

    this.logger.info("Starting recurring invoice scheduler");

    // Get due recurring invoices (batched for safety, default limit: 50)
    const { data: dueRecurring, hasMore } = await withDbConnectionRetry(
      () => getDueInvoiceRecurring(db),
      {
        operationName: "getDueInvoiceRecurring",
        logger: this.logger,
      },
    );

    if (dueRecurring.length === 0) {
      this.logger.info("No recurring invoices due for generation");
      return {
        processed: 0,
        skipped: 0,
        failed: 0,
        results: [],
        errors: [],
        hasMore: false,
      };
    }

    this.logger.info(
      `Found ${dueRecurring.length} recurring invoices to process${hasMore ? " (more pending)" : ""}`,
      { count: dueRecurring.length, hasMore },
    );

    const results: GeneratedInvoiceResult[] = [];
    const errors: Array<{ recurringId: string; error: string }> = [];
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const due of dueRecurring) {
      try {
        const outcome = await db.transaction(async (tx) => {
          const nextSequence = due.invoicesGenerated + 1;
          const recurring = await lockDueInvoiceRecurring(tx, {
            id: due.id,
            teamId: due.teamId,
            nextSequence,
            nextScheduledAt: due.nextScheduledAt,
          });
          if (!recurring) return { kind: "stale" as const };

          const existingInvoice = await checkInvoiceExists(tx, {
            teamId: recurring.teamId,
            invoiceRecurringId: recurring.id,
            recurringSequence: nextSequence,
          });
          if (
            existingInvoice &&
            existingInvoice.status !== "draft" &&
            existingInvoice.status !== "scheduled"
          ) {
            await markInvoiceGenerated(tx, {
              id: recurring.id,
              teamId: recurring.teamId,
            });
            return { kind: "skipped" as const };
          }

          let invoiceId = existingInvoice?.id;
          let invoiceNumber =
            existingInvoice?.invoiceNumber ?? `REC-${nextSequence}`;
          if (!existingInvoice) {
            const validation = validateRecurringDataIntegrity(recurring);
            if (!validation.isValid)
              throw RecurringInvoiceErrors.templateInvalid(
                recurring.id,
                validation.errors.join(", "),
                recurring.teamId,
              );
            if (!recurring.customerId)
              throw RecurringInvoiceErrors.customerDeleted(
                recurring.id,
                recurring.customerName,
                recurring.teamId,
              );
            const customer = await getCustomerById(tx, {
              id: recurring.customerId,
              teamId: recurring.teamId,
            });
            if (!customer)
              throw RecurringInvoiceErrors.customerNotFound(
                recurring.id,
                recurring.customerId,
                recurring.teamId,
              );
            const customerEmail = customer.billingEmail || customer.email;
            if (!customerEmail)
              throw RecurringInvoiceErrors.customerNoEmail(
                recurring.id,
                recurring.customerName || customer.name,
                recurring.teamId,
              );
            const customerContent = transformCustomerToContent(customer);
            const customerDetails = customerContent
              ? JSON.stringify(customerContent)
              : null;
            invoiceId = uuidv4();
            invoiceNumber = await getNextInvoiceNumber(tx, recurring.teamId);
            const token = await generateToken(invoiceId);
            const issueDateUTC = getStartOfDayUTC(
              new Date(recurring.nextScheduledAt!),
            );
            await draftInvoice(tx, {
              id: invoiceId,
              teamId: recurring.teamId,
              userId: recurring.userId,
              token,
              template: buildInvoiceTemplateFromRecurring(recurring),
              templateId: recurring.templateId ?? undefined,
              paymentDetails: stringifyJsonField(recurring.paymentDetails),
              fromDetails: stringifyJsonField(recurring.fromDetails),
              customerDetails,
              noteDetails: stringifyJsonField(recurring.noteDetails),
              dueDate: addDays(
                issueDateUTC,
                recurring.dueDateOffset,
              ).toISOString(),
              issueDate: issueDateUTC.toISOString(),
              invoiceNumber,
              vat: recurring.vat ?? undefined,
              tax: recurring.tax ?? undefined,
              discount: recurring.discount ?? undefined,
              subtotal: recurring.subtotal ?? undefined,
              topBlock: stringifyJsonField(recurring.topBlock),
              bottomBlock: stringifyJsonField(recurring.bottomBlock),
              amount: recurring.amount ?? undefined,
              lineItems: parseLineItems(recurring.lineItems),
              customerId: recurring.customerId,
              customerName: recurring.customerName ?? undefined,
            });
            await updateInvoice(tx, {
              id: invoiceId,
              teamId: recurring.teamId,
              sentTo: customerEmail,
              invoiceRecurringId: recurring.id,
              recurringSequence: nextSequence,
            });
          }
          if (!invoiceId)
            throw new Error("Recurring invoice identity is missing");
          const source = `${recurring.id}/${nextSequence}`;
          await ensureFinancialJobDispatch(tx, {
            teamId: recurring.teamId,
            jobName: "generate-invoice",
            source,
            payload: {
              teamId: recurring.teamId,
              invoiceId,
              deliveryType: "create_and_send",
              deliveryKey: financialJobOperationKey("generate-invoice", source),
            },
          });
          const updated = await markInvoiceGenerated(tx, {
            id: recurring.id,
            teamId: recurring.teamId,
          });
          await ensureFinancialJobDispatch(tx, {
            teamId: recurring.teamId,
            jobName: "notification",
            source: `${source}/generated`,
            payload: {
              type: "invoice_recurring_generated",
              invoiceId,
              invoiceNumber,
              teamId: recurring.teamId,
              customerName: recurring.customerName ?? undefined,
              recurringId: recurring.id,
              recurringSequence: nextSequence,
              recurringTotalCount: recurring.endCount ?? undefined,
            },
          });
          if (updated?.status === "completed") {
            await ensureFinancialJobDispatch(tx, {
              teamId: recurring.teamId,
              jobName: "notification",
              source: `${source}/completed`,
              payload: {
                type: "recurring_series_completed",
                invoiceId,
                invoiceNumber,
                teamId: recurring.teamId,
                customerName: recurring.customerName ?? undefined,
                recurringId: recurring.id,
                totalGenerated: nextSequence,
              },
            });
          }
          return {
            kind: "generated" as const,
            result: {
              invoiceId,
              invoiceNumber,
              recurringId: recurring.id,
              sequence: nextSequence,
            },
          };
        });
        if (outcome.kind === "generated") {
          results.push(outcome.result);
          processed++;
        } else skipped++;
      } catch (error) {
        const isRecurringError = error instanceof RecurringInvoiceError;
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.error("Failed to persist recurring invoice", {
          recurringId: due.id,
          errorCode: isRecurringError ? error.code : "UNKNOWN",
        });
        await db.transaction(async (tx) => {
          const { autoPaused } = await recordInvoiceGenerationFailure(tx, {
            id: due.id,
            teamId: due.teamId,
            expectedSequence: due.invoicesGenerated + 1,
            expectedNextScheduledAt: due.nextScheduledAt,
          });
          if (autoPaused) {
            await ensureFinancialJobDispatch(tx, {
              teamId: due.teamId,
              jobName: "notification",
              source: `${due.id}/${due.invoicesGenerated + 1}/paused`,
              payload: {
                type: "recurring_series_paused",
                teamId: due.teamId,
                customerName: due.customerName ?? undefined,
                recurringId: due.id,
              },
            });
          }
        });
        errors.push({
          recurringId: due.id,
          error: isRecurringError ? error.getUserMessage() : errorMessage,
        });
        failed++;
      }
    }

    this.logger.info("Recurring invoice scheduler completed", {
      processed,
      skipped,
      failed,
      total: dueRecurring.length,
      hasMore,
    });

    if (hasMore) {
      this.logger.info(
        "More recurring invoices pending - will be processed in next scheduler run",
      );
    }

    return {
      processed,
      skipped,
      failed,
      results,
      errors,
      hasMore,
    };
  }
}
