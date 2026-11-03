import { financialRequestHash } from "@midday/db/financial-job";
import {
  getInvoiceById,
  isCurrentInvoiceSchedule,
  prepareInvoiceDocument,
  reserveGeneratedStorage,
  updateInvoice,
} from "@midday/db/queries";
import { ensureFinancialJobDispatch } from "@midday/db/queries/financial-job-dispatches";
import { PdfTemplate, renderToBuffer } from "@midday/invoice";
import { reserveQueuedJob } from "@midday/job-client/resource-admission";
import { createTeamClient } from "@midday/supabase/job";
import { validateVaultKey } from "@midday/supabase/storage-path";
import type { Job } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../../config/job-options";
import { documentsQueue } from "../../queues/documents";
import type { GenerateInvoicePayload } from "../../schemas/invoices";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";
import { invoiceDeliveryOperationKey } from "./invoice-delivery-operation";

/**
 * Generate Invoice Processor
 * Handles PDF generation and storage upload for invoices
 * Optionally triggers email sending via send-invoice-email job
 */
export class GenerateInvoiceProcessor extends BaseProcessor<GenerateInvoicePayload> {
  async process(job: Job<GenerateInvoicePayload>): Promise<void> {
    const { invoiceId, deliveryType, expectedScheduledJobId } = job.data;
    if (!job.id)
      throw new Error("Invoice generation requires its queue identity");
    const db = getDb();

    this.logger.info("Starting invoice generation", {
      jobId: job.id,
      invoiceId,
      deliveryType,
    });

    // Fetch invoice data
    let invoiceData = await getInvoiceById(db, { id: invoiceId });

    if (!invoiceData) {
      this.logger.error("Failed to fetch invoice", { invoiceId });
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    if (
      expectedScheduledJobId !== undefined &&
      !isCurrentInvoiceSchedule(invoiceData, expectedScheduledJobId)
    ) {
      this.logger.info(
        "Skipping generation for a superseded invoice schedule",
        { invoiceId },
      );
      return;
    }

    // This worker is a publishing path, unlike read-only owner draft previews.
    const document = await prepareInvoiceDocument(db, {
      id: invoiceId,
      teamId: invoiceData.teamId,
      expectedScheduledJobId,
    });
    if (!document) {
      if (expectedScheduledJobId !== undefined) return;
      throw new Error("Invoice no longer exists");
    }
    invoiceData = document;
    const { user, ...invoice } = invoiceData;

    if (!invoice.template) {
      this.logger.error("Invoice has no template configured", { invoiceId });
      throw new Error(`Invoice ${invoiceId} has no template configured`);
    }

    this.logger.debug("Generating PDF", { invoiceId });

    // Generate PDF buffer
    const buffer = await renderToBuffer(await PdfTemplate(invoice));

    if (expectedScheduledJobId !== undefined) {
      const current = await getInvoiceById(db, {
        id: invoiceId,
        teamId: invoiceData.teamId,
      });
      if (
        !current ||
        !isCurrentInvoiceSchedule(current, expectedScheduledJobId)
      ) {
        this.logger.info(
          "Skipping superseded invoice schedule after PDF generation",
          { invoiceId },
        );
        return;
      }
    }

    const filename = `${invoiceData.invoiceNumber}.pdf`;
    const storageFilename = `${invoiceData.id}.pdf`;
    const { normalizedPath: fullPath, pathArray } = validateVaultKey(
      `${invoiceData.teamId}/invoices/${storageFilename}`,
    );

    this.logger.debug("Uploading PDF to storage", {
      invoiceId,
      fullPath,
      fileSize: buffer.length,
    });

    // Upload to Supabase storage (storage SDK is still needed)
    await reserveGeneratedStorage(db, {
      teamId: invoiceData.teamId,
      path: fullPath,
      bytes: buffer.length,
      sourceKind: "invoice",
      sourceId: invoiceId,
    });
    const supabase = createTeamClient(invoiceData.teamId);
    const { error: uploadError } = await supabase.storage
      .from("vault")
      .upload(fullPath, buffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      this.logger.error("Failed to upload PDF", {
        invoiceId,
        error: uploadError.message,
      });
      throw new Error(`Failed to upload PDF: ${uploadError.message}`);
    }

    this.logger.debug("PDF uploaded to storage", { invoiceId, fullPath });

    // Update invoice with file path and size using Drizzle
    const updated = await updateInvoice(db, {
      id: invoiceId,
      teamId: invoiceData.teamId,
      filePath: pathArray,
      fileSize: buffer.length,
    });

    if (!updated) {
      this.logger.error("Failed to update invoice with file info", {
        invoiceId,
      });
      throw new Error("Failed to update invoice with file info");
    }

    // Queue email sending if delivery type is create_and_send
    if (deliveryType === "create_and_send") {
      const deliveryKey = invoiceDeliveryOperationKey({
        teamId: invoiceData.teamId,
        invoiceId,
        kind: "invoice",
        job,
        expectedScheduledJobId,
        deliveryKey: job.data.deliveryKey,
      });
      await ensureFinancialJobDispatch(db, {
        teamId: invoiceData.teamId,
        jobName: "send-invoice-email",
        source: `invoice/${invoiceId}/delivery/${deliveryKey}`,
        payload: {
          teamId: invoiceData.teamId,
          invoiceId,
          filename,
          fullPath,
          deliveryKey,
          ...(job.data.approvedRecipients
            ? { approvedRecipients: job.data.approvedRecipients }
            : {}),
          ...(expectedScheduledJobId === undefined
            ? {}
            : { expectedScheduledJobId }),
        },
      });

      this.logger.debug("Persisted send-invoice-email intent", { invoiceId });
    }

    // Queue document processing for classification
    const documentPayload = {
      filePath: pathArray,
      mimetype: "application/pdf",
      teamId: invoiceData.teamId,
    };
    const documentJobId = await reserveQueuedJob(
      "documents",
      documentPayload,
      `invoice-document-${financialRequestHash([invoiceData.teamId, invoiceId, job.id])}`,
      "process-document",
    );
    const created = await documentsQueue.add(
      "process-document",
      documentPayload,
      {
        ...DEFAULT_JOB_OPTIONS,
        jobId: documentJobId,
      },
    );
    if (created.id !== documentJobId)
      throw new Error("Invoice document processing was not acknowledged");

    this.logger.info("Invoice generation completed", {
      invoiceId,
      filename,
      fullPath,
      deliveryType,
    });
  }
}
