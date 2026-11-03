export type ExportArchiveKind = "team" | "transactions";

export type StoredExportArchiveReceipt = {
  id: string;
  team_id: string;
  operation_key: string;
  snapshot_hash: string;
  snapshot_kind: string | null;
  snapshot_version: string | null;
  snapshot_at: string | null;
  // Callers select only the receipt fields below, never the business snapshot.
  result: unknown;
};

export type VerifiedExportArchiveReceipt = {
  kind: ExportArchiveKind;
  status: "complete" | "partial" | "failed";
  totalItems: number;
  missingFiles: number;
  path: string;
  sha256: string;
  snapshotAt: string;
};

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SNAPSHOT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validSnapshotTime(value: string | null): value is string {
  if (typeof value !== "string" || !SNAPSHOT_TIME.test(value)) return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate a backend receipt against its immutable snapshot identity.
 * This does not grant access or assert that Storage still contains the archive.
 * A failed/partial receipt can describe an intentionally incomplete artifact.
 */
export function validateExportArchiveReceipt(
  row: StoredExportArchiveReceipt,
  expectedTeamId: string,
): VerifiedExportArchiveReceipt | null {
  if (
    row.team_id !== expectedTeamId ||
    !UUID.test(expectedTeamId) ||
    !UUID.test(row.id) ||
    !HASH.test(row.operation_key) ||
    !HASH.test(row.snapshot_hash) ||
    (row.snapshot_kind !== "team" && row.snapshot_kind !== "transactions") ||
    row.snapshot_version !== "1" ||
    !validSnapshotTime(row.snapshot_at)
  )
    return null;

  const result = row.result;
  if (
    !object(result) ||
    result.operationId !== row.operation_key ||
    result.snapshotId !== row.id ||
    result.snapshotHash !== row.snapshot_hash ||
    typeof result.archiveHash !== "string" ||
    !HASH.test(result.archiveHash) ||
    result.fullPath !==
      `${expectedTeamId}/exports/${row.operation_key}/${result.archiveHash}.zip` ||
    !count(result.totalItems) ||
    !count(result.missingFiles) ||
    (result.status !== "complete" &&
      result.status !== "partial" &&
      result.status !== "failed") ||
    (result.status === "complete" && result.missingFiles !== 0)
  )
    return null;

  return {
    kind: row.snapshot_kind,
    status: result.status,
    totalItems: result.totalItems,
    missingFiles: result.missingFiles,
    path: `${expectedTeamId}/exports/${row.operation_key}/${result.archiveHash}.zip`,
    sha256: result.archiveHash,
    snapshotAt: row.snapshot_at,
  };
}
