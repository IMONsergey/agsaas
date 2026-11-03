import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { writeToString } from "@fast-csv/format";
import { financialRequestHash } from "@midday/db/financial-job";
import type { createClient } from "@midday/supabase/job";
import { requireVaultPathForTeam } from "@midday/supabase/storage-path";
import archiver from "archiver";
import { TIMEOUTS, withTimeout } from "./timeout";

type StorageClient = ReturnType<typeof createClient>;
export type ArchiveFile = { name: string; data: Buffer };
export type AssetRequest = {
  id: string;
  transactionId?: string;
  path: string[] | null;
  name: string;
  size?: number | null;
  contentType?: string | null;
};
export type AssetReceipt = {
  id: string;
  transactionId?: string;
  source: string | null;
  name: string;
  status: "included" | "missing" | "invalid";
  bytes?: number;
  sha256?: string;
  reason?: string;
};
export type ExportOutcome = "complete" | "partial" | "failed";
export type ExportResult = {
  filePath: string;
  fullPath: string;
  fileName: string;
  totalItems: number;
  status: ExportOutcome;
  missingFiles: number;
  operationId: string;
  snapshotId: string;
  snapshotHash: string;
  archiveHash: string;
};

export function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
export function exportOperationKey(
  teamId: string,
  job: { id?: string; name: string },
) {
  if (!job.id) throw new Error("An export requires a durable job identity");
  return financialRequestHash(["export-v1", teamId, job.name, job.id]);
}
export function safeArchiveName(value: string) {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Filename controls and CSV prefixes are intentionally sanitized.
      .replace(/[\x00-\x1f\x7f/\\?%*:|"<>]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 150) || "file"
  );
}

/** CSV quoting does not disable formulas. Numeric amounts remain numeric, including negatives. */
export function safeCsvCell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet parsers may trim spaces, controls and BOM before formula detection.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Filename controls and CSV prefixes are intentionally sanitized.
  return /^[\s\u0000-\u001f\u007f\ufeff]*[=+\-@]/u.test(text) ||
    /^[\t\r\n]/.test(text)
    ? `'${text}`
    : text;
}
export function safeCsvRows(rows: unknown[][]) {
  return rows.map((row) => row.map(safeCsvCell));
}
export async function recordsToCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  return writeToString(
    rows.map((row) => headers.map((key) => safeCsvCell(row[key]))),
    { headers },
  );
}

/** Validate the whole batch before any service-role Storage IO, including caught-error paths. */
export function validateExportAssetPaths(
  teamId: string,
  assets: AssetRequest[],
) {
  return assets.map((asset) =>
    asset.path?.length
      ? requireVaultPathForTeam(asset.path, teamId).normalizedPath
      : null,
  );
}

export async function collectExportAssets(
  client: StorageClient,
  teamId: string,
  assets: AssetRequest[],
) {
  const paths = validateExportAssetPaths(teamId, assets);
  const files: ArchiveFile[] = [];
  const receipts: AssetReceipt[] = [];
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]!;
    const path = paths[i] ?? null;
    const receipt: AssetReceipt = {
      id: asset.id,
      transactionId: asset.transactionId,
      source: path,
      name: asset.name,
      status: "missing",
    };
    if (!path) {
      receipts.push({ ...receipt, reason: "missing_source_path" });
      continue;
    }
    try {
      const response = await withTimeout(
        () => client.storage.from("vault").download(path),
        TIMEOUTS.FILE_DOWNLOAD,
        "Export download timeout",
      );
      if (response.error || !response.data) {
        receipts.push({ ...receipt, reason: "download_failed" });
        continue;
      }
      const bytes = Buffer.from(await response.data.arrayBuffer());
      if (
        (asset.size != null && asset.size !== bytes.length) ||
        bytes.length === 0
      ) {
        receipts.push({
          ...receipt,
          status: "invalid",
          reason: "size_mismatch",
        });
        continue;
      }
      if (
        asset.contentType === "application/pdf" &&
        bytes.subarray(0, 5).toString() !== "%PDF-"
      ) {
        receipts.push({ ...receipt, status: "invalid", reason: "invalid_pdf" });
        continue;
      }
      files.push({ name: asset.name, data: bytes });
      receipts.push({
        ...receipt,
        status: "included",
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    } catch {
      receipts.push({ ...receipt, reason: "download_or_read_error" });
    }
  }
  return { files, receipts };
}

export function exportOutcome(
  requestedIds: string[],
  foundIds: string[],
  receipts: AssetReceipt[],
) {
  const found = new Set(foundIds);
  const missingRows = requestedIds.filter((id) => !found.has(id));
  const missing = receipts.filter((row) => row.status !== "included");
  const blocked = new Set(
    missing.map((row) => row.transactionId).filter(Boolean),
  );
  return {
    status: (requestedIds.length > 0 && foundIds.length === 0
      ? "failed"
      : missingRows.length || missing.length
        ? "partial"
        : "complete") as ExportOutcome,
    missingRows,
    missingFiles: missing.length,
    completeIds: foundIds.filter((id) => !blocked.has(id)),
  };
}

export function buildExportManifest(input: {
  operationId: string;
  snapshotId: string;
  snapshotHash: string;
  asOf: string;
  status: ExportOutcome;
  tables: Record<string, Record<string, unknown>[]>;
  files: ArchiveFile[];
  assets: AssetReceipt[];
  missingRows: string[];
  omissions: string[];
}) {
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    snapshotId: input.snapshotId,
    snapshotHash: input.snapshotHash,
    sqlAsOf: input.asOf,
    status: input.status,
    tableCounts: Object.fromEntries(
      Object.entries(input.tables).map(([name, rows]) => [name, rows.length]),
    ),
    files: input.files.map((file) => ({
      path: file.name,
      bytes: file.data.length,
      sha256: sha256(file.data),
    })),
    assets: input.assets,
    missingTransactionIds: input.missingRows,
    omissions: input.omissions,
    csvTextEscaping:
      "Strings with spreadsheet formula prefixes have a leading apostrophe. JSON preserves original values. Numeric values remain numeric.",
    fileConsistency:
      "Files are read after the SQL snapshot and SHA-256 identifies the exported bytes. Storage has no historical read boundary.",
  };
}

export async function zipExportFiles(files: ArchiveFile[], asOf: string) {
  const names = new Set<string>();
  for (const file of files) {
    if (
      names.has(file.name) ||
      file.name.startsWith("/") ||
      file.name.split("/").some((part) => part === ".." || !part)
    )
      throw new Error("Duplicate or unsafe archive entry");
    names.add(file.name);
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    const archive = archiver("zip", { zlib: { level: 9 } });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", reject);
    archive.pipe(stream);
    for (const file of [...files].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      archive.append(file.data, { name: file.name, date: new Date(asOf) });
    }
    void archive.finalize().catch(reject);
  });
}

/** Immutable content-addressed objects; an acknowledged retry can only reuse identical bytes. */
export async function storeImmutableExport(
  client: StorageClient,
  input: {
    teamId: string;
    operationId: string;
    zip: Buffer;
    beforeUpload?: (path: string, bytes: number) => Promise<void>;
  },
) {
  if (!/^[a-f0-9]{64}$/.test(input.operationId))
    throw new Error("Invalid export operation");
  const archiveHash = sha256(input.zip);
  const fullPath = `${input.teamId}/exports/${input.operationId}/${archiveHash}.zip`;
  requireVaultPathForTeam(fullPath, input.teamId);
  await input.beforeUpload?.(fullPath, input.zip.length);
  const { error } = await withTimeout(
    () =>
      client.storage.from("vault").upload(fullPath, input.zip, {
        upsert: false,
        contentType: "application/zip",
      }),
    TIMEOUTS.FILE_UPLOAD,
    "Export upload timeout",
  );
  if (error) {
    // Covers both existing-object responses and loss of an upload acknowledgement.
    const existing = await withTimeout(
      () => client.storage.from("vault").download(fullPath),
      TIMEOUTS.FILE_DOWNLOAD,
      "Export receipt verification timeout",
    );
    if (
      existing.error ||
      !existing.data ||
      sha256(Buffer.from(await existing.data.arrayBuffer())) !== archiveHash
    )
      throw new Error("Immutable export upload was not verified");
  }
  return { fullPath, archiveHash };
}
