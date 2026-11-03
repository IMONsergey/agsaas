import { getTransactionsByIds } from "@midday/db/queries";
import { createTeamClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import type { ProcessExportPayload } from "../../schemas/transactions";
import { getDb } from "../../utils/db";
import { collectExportAssets } from "../../utils/export-archive";
import { BaseProcessor } from "../base";
import { formatTransactionExport } from "./transaction-export-format";

/** Legacy standalone processor. Full archive processors use a persisted SQL snapshot. */
export class ProcessExportProcessor extends BaseProcessor<ProcessExportPayload> {
  async processTransactions(params: {
    ids: string[];
    teamId: string;
    locale: string;
    dateFormat?: string | null;
    onProgress?: (progress: number) => Promise<void>;
  }) {
    const { ids, teamId, locale, dateFormat, onProgress } = params;
    const supabase = createTeamClient(teamId);
    await onProgress?.(10);
    const transactions = await getTransactionsByIds(getDb(), { ids, teamId });
    if (new Set(transactions.map((row) => row.id)).size !== new Set(ids).size)
      throw new Error("Export selection contains missing transactions");
    const formatted = formatTransactionExport(transactions, locale, dateFormat);
    const { files, receipts } = await collectExportAssets(
      supabase,
      teamId,
      formatted.assets,
    );
    if (receipts.some((receipt) => receipt.status !== "included"))
      throw new Error("Export contains unavailable or invalid attachments");
    await onProgress?.(100);
    return {
      rows: formatted.rows,
      attachments: files.map((file) => ({
        id: receipts.find((receipt) => receipt.name === file.name)!
          .transactionId!,
        name: file.name,
        blob: new Blob([Uint8Array.from(file.data)]),
      })),
    };
  }
  async process(job: Job<ProcessExportPayload>) {
    return this.processTransactions({
      ...job.data,
      onProgress: (progress) => this.updateProgress(job, progress),
    });
  }
}
