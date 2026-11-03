import { reconcileStorageDocuments } from "@midday/db/queries/storage-document-ingestion";
import type { Job } from "bullmq";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";

/** Repairs lost/legacy metadata projection from the authoritative catalog.
 * AI classification remains a separate capability and is never faked here. */
export class ReconcileStorageDocumentsProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job<Record<string, never>>) {
    const result = await reconcileStorageDocuments(getDb(), 50);
    this.logger.info("Storage document metadata reconciled", result);
    return result;
  }
}
