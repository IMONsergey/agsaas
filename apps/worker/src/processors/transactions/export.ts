import { writeToString } from "@fast-csv/format";
import { createShortLink, updateDocumentByPath } from "@midday/db/queries";
import {
  getOrCreateExportSnapshot,
  markSnapshotTransactionsExported,
  recordExportResult,
} from "@midday/db/queries/export-snapshots";
import { reserveGeneratedStorage } from "@midday/db/queries/team-entitlements";
import { triggerJob } from "@midday/job-client";
import { createTeamClient } from "@midday/supabase/job";
import { signedUrl } from "@midday/supabase/storage";
import { getAppUrl } from "@midday/utils/envs";
import type { Job } from "bullmq";
import xlsx from "node-xlsx";
import type { ExportTransactionsPayload } from "../../schemas/transactions";
import { getDb } from "../../utils/db";
import {
  type ArchiveFile,
  buildExportManifest,
  collectExportAssets,
  type ExportResult,
  exportOperationKey,
  exportOutcome,
  safeCsvRows,
  storeImmutableExport,
  zipExportFiles,
} from "../../utils/export-archive";
import { BaseProcessor } from "../base";
import { formatTransactionExport } from "./transaction-export-format";

export const transactionExportColumns = [
  "ID",
  "Date",
  "Description",
  "Additional info",
  "Amount",
  "Currency",
  "Formatted amount",
  "Base amount",
  "Base currency",
  "Tax type",
  "Tax rate",
  "Tax amount",
  "Base tax amount",
  "From / To",
  "Category",
  "Category description",
  "Tax reporting code",
  "Status",
  "Attachments",
  "Balance",
  "Account",
  "Note",
  "Tags",
];

export class ExportTransactionsProcessor extends BaseProcessor<ExportTransactionsPayload> {
  async process(job: Job<ExportTransactionsPayload>): Promise<ExportResult> {
    const {
      teamId,
      userId,
      userEmail,
      locale,
      transactionIds,
      dateFormat,
      exportSettings,
    } = job.data;
    const supabase = createTeamClient(teamId);
    const db = getDb();
    const operationId = exportOperationKey(teamId, job);
    const persisted = await getOrCreateExportSnapshot(db, {
      teamId,
      operationKey: operationId,
      kind: "transactions",
      request: job.data,
      transactionIds,
    });
    if (persisted.result?.status === "complete")
      return persisted.result as ExportResult;
    const snapshot = persisted.snapshot;
    const settings = {
      csvDelimiter: exportSettings?.csvDelimiter ?? ",",
      includeCSV: exportSettings?.includeCSV ?? true,
      includeXLSX: exportSettings?.includeXLSX ?? true,
      sendEmail: exportSettings?.sendEmail ?? false,
      sendCopyToMe: exportSettings?.sendCopyToMe ?? false,
      accountantEmail: exportSettings?.accountantEmail,
    };
    await this.updateProgress(job, 20);
    const formatted = formatTransactionExport(
      snapshot.transactionRows,
      locale,
      dateFormat,
    );
    const assets = await collectExportAssets(
      supabase,
      teamId,
      formatted.assets,
    );
    const outcome = exportOutcome(
      snapshot.requestedTransactionIds,
      snapshot.transactionRows.map((row) => row.id),
      assets.receipts,
    );
    const files: ArchiveFile[] = [
      {
        name: "data/snapshot.json",
        data: Buffer.from(JSON.stringify(snapshot, null, 2)),
      },
      ...assets.files,
    ];
    if (settings.includeCSV)
      files.push({
        name: "transactions.csv",
        data: Buffer.from(
          await writeToString(safeCsvRows(formatted.rows), {
            headers: transactionExportColumns,
            delimiter: settings.csvDelimiter,
          }),
        ),
      });
    if (settings.includeXLSX)
      files.push({
        name: "transactions.xlsx",
        data: Buffer.from(
          xlsx.build([
            {
              name: "Transactions",
              data: [
                transactionExportColumns,
                ...formatted.rows.map((row) => row.map((cell) => cell ?? "")),
              ],
              options: {},
            },
          ]),
        ),
      });
    const manifest = buildExportManifest({
      operationId,
      snapshotId: persisted.id,
      snapshotHash: persisted.snapshot_hash,
      asOf: snapshot.asOf,
      status: outcome.status,
      tables: snapshot.tables,
      files,
      assets: assets.receipts,
      missingRows: outcome.missingRows,
      omissions: snapshot.omissions,
    });
    files.push({
      name: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest, null, 2)),
    });
    await this.updateProgress(job, 80);
    const zip = await zipExportFiles(files, snapshot.asOf);
    const stored = await storeImmutableExport(supabase, {
      teamId,
      operationId,
      zip,
      beforeUpload: (path, bytes) =>
        reserveGeneratedStorage(db, {
          teamId,
          path,
          bytes,
          sourceKind: "export",
          sourceId: persisted.id,
        }),
    });
    const filePath = `export-${snapshot.asOf.slice(0, 10)}-${operationId.slice(0, 8)}`;
    const result: ExportResult = {
      ...stored,
      filePath,
      fileName: `${filePath}.zip`,
      totalItems: formatted.rows.length,
      status: outcome.status,
      missingFiles: outcome.missingFiles,
      operationId,
      snapshotId: persisted.id,
      snapshotHash: persisted.snapshot_hash,
    };
    await markSnapshotTransactionsExported(db, {
      teamId,
      rows: snapshot.tables.transactions ?? [],
      completeIds: outcome.completeIds,
    });
    await recordExportResult(db, { id: persisted.id, teamId, result });
    // The upload projection may be asynchronous; absence of a document row cannot invalidate the archive.
    await updateDocumentByPath(db, {
      pathTokens: stored.fullPath.split("/"),
      teamId,
      processingStatus: "completed",
    });
    if (
      outcome.status === "complete" &&
      settings.sendEmail &&
      settings.accountantEmail
    ) {
      const expireIn = 7 * 24 * 60 * 60;
      const { data } = await signedUrl(supabase, {
        bucket: "vault",
        path: stored.fullPath,
        expireIn,
        options: { download: true },
      });
      if (data?.signedUrl) {
        const shortLink = await createShortLink(db, {
          url: data.signedUrl,
          teamId,
          userId,
          type: "download",
          fileName: result.fileName,
          mimeType: "application/zip",
          expiresAt: new Date(Date.now() + expireIn * 1000).toISOString(),
        });
        if (shortLink) {
          try {
            await triggerJob(
              "notification",
              {
                type: "transactions_exported",
                teamId,
                userEmail,
                transactionCount: formatted.rows.length,
                downloadLink: `${getAppUrl()}/s/${shortLink.shortId}`,
                accountantEmail: settings.accountantEmail,
                sendCopyToMe: userEmail ? settings.sendCopyToMe : false,
              },
              "notifications",
            );
          } catch {
            this.logger.warn(
              "Export completed but notification queue was unavailable",
              { operationId },
            );
          }
        }
      }
    }
    await this.updateProgress(job, 100);
    return result;
  }
}
