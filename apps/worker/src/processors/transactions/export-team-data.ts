import { writeToString } from "@fast-csv/format";
import { updateDocumentByPath } from "@midday/db/queries";
import {
  getOrCreateExportSnapshot,
  recordExportResult,
} from "@midday/db/queries/export-snapshots";
import { reserveGeneratedStorage } from "@midday/db/queries/team-entitlements";
import { createTeamClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import type { ExportTeamDataPayload } from "../../schemas/transactions";
import { getDb } from "../../utils/db";
import {
  type ArchiveFile,
  type AssetRequest,
  buildExportManifest,
  collectExportAssets,
  type ExportResult,
  exportOperationKey,
  exportOutcome,
  recordsToCsv,
  safeArchiveName,
  safeCsvRows,
  storeImmutableExport,
  zipExportFiles,
} from "../../utils/export-archive";
import { BaseProcessor } from "../base";
import { transactionExportColumns } from "./export";
import { formatTransactionExport } from "./transaction-export-format";

function path(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

export class ExportTeamDataProcessor extends BaseProcessor<ExportTeamDataPayload> {
  async process(job: Job<ExportTeamDataPayload>): Promise<ExportResult> {
    const { teamId, locale, dateFormat } = job.data;
    const supabase = createTeamClient(teamId);
    const db = getDb();
    const operationId = exportOperationKey(teamId, job);
    const persisted = await getOrCreateExportSnapshot(db, {
      teamId,
      operationKey: operationId,
      kind: "team",
      request: job.data,
    });
    if (persisted.result?.status === "complete")
      return persisted.result as ExportResult;
    const snapshot = persisted.snapshot;
    await this.updateProgress(job, 15);
    const formatted = formatTransactionExport(
      snapshot.transactionRows,
      locale ?? "en",
      dateFormat,
    );
    const requests: AssetRequest[] = [...formatted.assets];
    for (const invoice of snapshot.tables.invoices ?? []) {
      if (
        !path(invoice.file_path)?.length &&
        !invoice.document_snapshot &&
        !invoice.sent_at &&
        !invoice.paid_at
      )
        continue;
      requests.push({
        id: `invoice/${invoice.id}`,
        path: path(invoice.file_path),
        name: `invoices/${invoice.id}_${safeArchiveName(String(invoice.invoice_number ?? "invoice"))}.pdf`,
        size: typeof invoice.file_size === "number" ? invoice.file_size : null,
        contentType: "application/pdf",
      });
    }
    for (const document of snapshot.tables.documents ?? [])
      requests.push({
        id: `document/${document.id}`,
        path: path(document.path_tokens),
        name: `documents/${document.id}_${safeArchiveName(String(document.name ?? "file"))}`,
      });
    for (const item of snapshot.tables.inbox ?? [])
      requests.push({
        id: `inbox/${item.id}`,
        path: path(item.file_path),
        name: `inbox/${item.id}_${safeArchiveName(String(item.file_name ?? "file"))}`,
        size: typeof item.size === "number" ? item.size : null,
        contentType:
          typeof item.content_type === "string" ? item.content_type : null,
      });
    const assets = await collectExportAssets(supabase, teamId, requests);
    const outcome = exportOutcome(
      snapshot.requestedTransactionIds,
      snapshot.transactionRows.map((row) => row.id),
      assets.receipts,
    );
    await this.updateProgress(job, 70);
    const files: ArchiveFile[] = [
      ...assets.files,
      {
        name: "data/snapshot.json",
        data: Buffer.from(JSON.stringify(snapshot, null, 2)),
      },
      {
        name: "transactions.csv",
        data: Buffer.from(
          await writeToString(safeCsvRows(formatted.rows), {
            headers: transactionExportColumns,
          }),
        ),
      },
    ];
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      files.push({
        name: `data/${table}.json`,
        data: Buffer.from(JSON.stringify(rows, null, 2)),
      });
      if (table !== "transactions")
        files.push({
          name: `${table.replaceAll("_", "-")}.csv`,
          data: Buffer.from(await recordsToCsv(rows)),
        });
    }
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
    const filePath = `team-export-${snapshot.asOf.slice(0, 10)}-${operationId.slice(0, 8)}`;
    const result: ExportResult = {
      ...stored,
      filePath,
      fileName: `${filePath}.zip`,
      totalItems: Object.values(snapshot.tables).reduce(
        (count, rows) => count + rows.length,
        0,
      ),
      status: outcome.status,
      missingFiles: outcome.missingFiles,
      operationId,
      snapshotId: persisted.id,
      snapshotHash: persisted.snapshot_hash,
    };
    await recordExportResult(db, { id: persisted.id, teamId, result });
    await updateDocumentByPath(db, {
      pathTokens: stored.fullPath.split("/"),
      teamId,
      processingStatus: "completed",
    });
    await this.updateProgress(job, 100);
    return result;
  }
}
