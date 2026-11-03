import {
  type StoredExportArchiveReceipt,
  validateExportArchiveReceipt,
} from "./export-archive-receipt";

// Metadata-only history for the version 1 full-team export contract.
export type ExportHistoryCursor = { createdAt: string; id: string };
export type ExportHistoryEntry = {
  id: string;
  operationId: string;
  snapshotHash: string;
  createdAt: string;
  updatedAt: string;
  snapshotAt: string | null;
  outcome: "unknown" | "unverified" | "complete" | "partial" | "failed";
  totalItems: number | null;
  missingFiles: number | null;
  archive: { path: string; fileName: string; sha256: string } | null;
};
export type StoredExportHistoryRecord = StoredExportArchiveReceipt & {
  created_at: string;
  updated_at: string;
};

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function validTime(value: string) {
  const time = new Date(value);
  return (
    Number.isFinite(time.getTime()) &&
    time.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
export function validateExportHistoryId(id: string) {
  if (!UUID.test(id)) throw new Error("Invalid export history ID");
}
export function validateExportHistoryPage(input: {
  limit?: number;
  cursor?: ExportHistoryCursor;
}) {
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
    throw new Error("Export history page size must be between 1 and 25");
  if (input.cursor) {
    validateExportHistoryId(input.cursor.id);
    if (
      !CURSOR_TIME.test(input.cursor.createdAt) ||
      !validTime(input.cursor.createdAt)
    )
      throw new Error("Invalid export history cursor");
  }
  return limit;
}

// A saved receipt describes a recorded outcome, not live Storage existence.
export function projectExportHistoryRecord(
  row: StoredExportHistoryRecord,
  teamId: string,
): ExportHistoryEntry {
  if (
    row.team_id !== teamId ||
    !UUID.test(row.id) ||
    !UUID.test(teamId) ||
    !HASH.test(row.operation_key) ||
    !HASH.test(row.snapshot_hash) ||
    !CURSOR_TIME.test(row.created_at) ||
    !validTime(row.created_at) ||
    !CURSOR_TIME.test(row.updated_at) ||
    !validTime(row.updated_at)
  )
    throw new Error("Invalid export snapshot metadata");

  const snapshotAt =
    row.snapshot_version === "1" &&
    typeof row.snapshot_at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.snapshot_at) &&
    validTime(row.snapshot_at)
      ? row.snapshot_at
      : null;
  const base: ExportHistoryEntry = {
    id: row.id,
    operationId: row.operation_key,
    snapshotHash: row.snapshot_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshotAt,
    outcome: row.result === null ? "unknown" : "unverified",
    totalItems: null,
    missingFiles: null,
    archive: null,
  };
  // History and archive authorization use this same strict receipt validator.
  const receipt = validateExportArchiveReceipt(row, teamId);
  if (!receipt || receipt.kind !== "team") return base;
  return {
    ...base,
    outcome: receipt.status,
    totalItems: receipt.totalItems,
    missingFiles: receipt.missingFiles,
    archive: {
      path: receipt.path,
      fileName: `team-export-${receipt.snapshotAt.slice(0, 10)}-${row.operation_key.slice(0, 8)}.zip`,
      sha256: receipt.sha256,
    },
  };
}
