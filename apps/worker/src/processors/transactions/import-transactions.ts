import { upsertTransactions } from "@midday/db/queries";
import { mapTransactions } from "@midday/import/mappings";
import { createTransactionTransformer } from "@midday/import/transform";
import { validateTransactions } from "@midday/import/validate";
import { triggerJob } from "@midday/job-client";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import Papa from "papaparse";
import {
  type ImportTransactionsPayload,
  importTransactionsSchema,
} from "../../schemas/transactions";
import { getDb } from "../../utils/db";
import { processBatch } from "../../utils/process-batch";
import { TIMEOUTS, withTimeout } from "../../utils/timeout";
import { BaseProcessor } from "../base";

const BATCH_SIZE = 500;

/**
 * Imports transactions from CSV files
 * Parses CSV, maps columns, validates, and upserts transactions
 * Then triggers embedding for imported transactions
 */
export class ImportTransactionsProcessor extends BaseProcessor<ImportTransactionsPayload> {
  protected getPayloadSchema() {
    return importTransactionsSchema;
  }

  async process(job: Job<ImportTransactionsPayload>): Promise<{
    importedCount: number;
    skippedCount: number;
    invalidCount: number;
  }> {
    const {
      teamId,
      filePath,
      bankAccountId,
      currency,
      mappings,
      inverted,
      parseProfile,
    } = job.data;
    const db = getDb();
    const supabase = createClient();

    this.logger.info("Starting import-transactions job", {
      jobId: job.id,
      teamId,
      filePath: filePath?.join("/"),
      bankAccountId,
      currency,
    });

    if (!filePath) {
      throw new Error("File path is required");
    }

    await this.updateProgress(job, this.ProgressMilestones.FETCHED);

    // Download file from Supabase storage with timeout
    const { data: fileData } = await withTimeout(
      supabase.storage.from("vault").download(filePath.join("/")),
      TIMEOUTS.FILE_DOWNLOAD,
      `File download timed out after ${TIMEOUTS.FILE_DOWNLOAD}ms`,
    );

    const content = await fileData?.text();

    if (!content) {
      throw new Error("File content is required");
    }

    await this.updateProgress(job, 20, undefined, "analyzing");

    const allTransactionIds: string[] = [];
    let totalAttempted = 0;
    let totalInvalid = 0;
    const transformRow = createTransactionTransformer({
      inverted,
      parseProfile,
    });

    let processedChunks = 0;
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const config: Papa.ParseLocalConfig<Record<string, string>> & {
        download: false;
        worker: false;
      } = {
        header: true,
        skipEmptyLines: true,
        worker: false,
        download: false,
        chunkSize: 64 * 1024,
        complete: () => {
          if (!failed) resolve();
        },
        error: (error: Error) => {
          failed = true;
          reject(error);
        },
        chunk: (chunk, parser) => {
          parser.pause();

          // Papa does not await async callbacks. Always settle this outer
          // promise on transform/database errors rather than leaving a paused
          // parser (and the worker job) pending forever.
          void (async () => {
            if (chunk.errors.length > 0) {
              throw new Error(
                "CSV contains malformed rows. Check quoting and column counts.",
              );
            }

            const { data } = chunk;

            if (!data?.length) {
              parser.resume();
              return;
            }

            const mappedTransactions = mapTransactions(
              data,
              mappings,
              currency,
              teamId,
              bankAccountId,
            );

            const transformedTransactions =
              mappedTransactions.map(transformRow);

            await this.updateProgress(job, 35, undefined, "transforming");

            const { validTransactions, invalidTransactions } =
              validateTransactions(transformedTransactions);

            await this.updateProgress(job, 45, undefined, "validating");

            if (invalidTransactions.length > 0) {
              this.logger.error("Invalid transactions", {
                invalidTransactions,
              });
            }

            totalAttempted += validTransactions.length;
            totalInvalid += invalidTransactions.length;

            await this.updateProgress(
              job,
              Math.min(75, 50 + processedChunks * 5),
              undefined,
              "importing",
            );

            const totalImportBatches = Math.max(
              1,
              Math.ceil(validTransactions.length / BATCH_SIZE),
            );
            let completedImportBatches = 0;

            // Upsert transactions using db query function
            const results = await processBatch(
              validTransactions,
              BATCH_SIZE,
              async (batch) => {
                // Transform snake_case to camelCase for Drizzle schema
                // Only include fields that exist in the validated transaction
                const transformedBatch = batch.map((t) => ({
                  name: t.name,
                  date: t.date,
                  method: (t.method === "card"
                    ? "card_purchase"
                    : t.method === "bank"
                      ? "transfer"
                      : "other") as "other" | "card_purchase" | "transfer",
                  amount: t.amount,
                  currency: t.currency,
                  teamId: t.team_id,
                  bankAccountId: t.bank_account_id ?? null,
                  internalId: t.internal_id,
                  status: t.status as
                    | "pending"
                    | "completed"
                    | "archived"
                    | "posted"
                    | "excluded",
                  manual: t.manual,
                  categorySlug: t.category_slug ?? null,
                  // Optional fields that may not exist in imported transactions
                  description: null,
                  balance: null,
                  note: null,
                  counterpartyName: t.counterparty_name ?? null,
                  merchantName: null,
                  assignedId: null,
                  internal: false,
                  notified: true,
                  baseAmount: null,
                  baseCurrency: null,
                  taxAmount: null,
                  taxRate: null,
                  taxType: null,
                  recurring: false,
                  frequency: null,
                  enrichmentCompleted: false,
                }));

                // Upsert transactions with conflict handling on internalId
                const upserted = await upsertTransactions(db, {
                  transactions: transformedBatch,
                  teamId,
                });

                completedImportBatches += 1;
                const importingProgress =
                  50 +
                  Math.round(
                    (completedImportBatches / totalImportBatches) * 25,
                  );
                await this.updateProgress(
                  job,
                  Math.min(75, importingProgress),
                  undefined,
                  "importing",
                );

                return upserted;
              },
            );

            processedChunks += 1;

            // Collect all transaction IDs
            const batchTransactionIds = results
              .flat()
              .map((tx) => tx.id)
              .filter(Boolean);

            allTransactionIds.push(...batchTransactionIds);

            parser.resume();
          })().catch((error: unknown) => {
            failed = true;
            // abort invokes complete synchronously; failed prevents success.
            parser.abort();
            reject(error);
          });
        },
      };
      Papa.parse(content, config);
    });

    if (totalAttempted + totalInvalid === 0) {
      throw new Error("CSV contains no transaction rows");
    }

    await this.updateProgress(job, 80, undefined, "finalizing");

    if (allTransactionIds.length > 0) {
      await triggerJob(
        "enrich-transactions",
        {
          transactionIds: allTransactionIds,
          teamId,
        },
        "transactions",
      );

      await triggerJob(
        "match-transactions-bidirectional",
        {
          teamId,
          newTransactionIds: allTransactionIds,
        },
        "inbox",
      );

      await this.updateProgress(job, 90, undefined, "enriching");
    }

    await this.updateProgress(job, 100, undefined, "completed");

    const importedCount = allTransactionIds.length;
    const skippedCount = Math.max(0, totalAttempted - importedCount);

    this.logger.info("Import transactions completed", {
      importedCount,
      skippedCount,
      invalidCount: totalInvalid,
      teamId,
    });

    return { importedCount, skippedCount, invalidCount: totalInvalid };
  }
}
