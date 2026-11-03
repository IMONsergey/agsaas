import { describe, expect, test } from "bun:test";
import {
  projectExportHistoryRecord,
  type StoredExportHistoryRecord,
  validateExportHistoryPage,
} from "./export-history";

const TEAM = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const OPERATION = "a".repeat(64);
const SNAPSHOT = "b".repeat(64);
const ARCHIVE = "c".repeat(64);

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OPERATION,
    snapshotId: ID,
    snapshotHash: SNAPSHOT,
    archiveHash: ARCHIVE,
    fullPath: `${TEAM}/exports/${OPERATION}/${ARCHIVE}.zip`,
    totalItems: 12,
    missingFiles: 0,
    status: "complete",
    fileName: "untrusted-private-filename.zip",
    providerSecret: "private-provider-secret",
    ...overrides,
  };
}
function record(result: unknown = receipt()): StoredExportHistoryRecord {
  return {
    id: ID,
    team_id: TEAM,
    operation_key: OPERATION,
    snapshot_hash: SNAPSHOT,
    snapshot_kind: "team",
    snapshot_version: "1",
    snapshot_at: "2026-11-03T12:00:00.000Z",
    created_at: "2026-11-03T12:00:00.000001Z",
    updated_at: "2026-11-03T12:00:01.000002Z",
    result,
  };
}

describe("metadata-only full-team export receipt contract", () => {
  test("whitelists a bound complete receipt and generates the filename", () => {
    const projected = projectExportHistoryRecord(record(), TEAM);
    expect(projected).toEqual({
      id: ID,
      operationId: OPERATION,
      snapshotHash: SNAPSHOT,
      createdAt: "2026-11-03T12:00:00.000001Z",
      updatedAt: "2026-11-03T12:00:01.000002Z",
      snapshotAt: "2026-11-03T12:00:00.000Z",
      outcome: "complete",
      totalItems: 12,
      missingFiles: 0,
      archive: {
        path: `${TEAM}/exports/${OPERATION}/${ARCHIVE}.zip`,
        fileName: "team-export-2026-11-03-aaaaaaaa.zip",
        sha256: ARCHIVE,
      },
    });
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(projected).not.toHaveProperty("result");
    expect(projected).not.toHaveProperty("snapshot");
    expect(projected).not.toHaveProperty("transactionRows");
  });

  test("missing result means unknown and contains no archive or invented count", () => {
    expect(projectExportHistoryRecord(record(null), TEAM)).toMatchObject({
      outcome: "unknown",
      archive: null,
      totalItems: null,
      missingFiles: null,
    });
  });

  test("shared validation denies a bad path and non-team receipts without leaking fields", () => {
    const bad = record(
      receipt({ fullPath: "https://foreign.example.test/archive.zip" }),
    );
    expect(projectExportHistoryRecord(bad, TEAM)).toMatchObject({
      outcome: "unverified",
      archive: null,
      totalItems: null,
      missingFiles: null,
    });
    expect(
      projectExportHistoryRecord(
        { ...record(), snapshot_kind: "transactions" },
        TEAM,
      ).archive,
    ).toBeNull();
  });

  test("partial with zero missing files remains incomplete because rows may be missing", () => {
    expect(
      projectExportHistoryRecord(record(receipt({ status: "partial" })), TEAM),
    ).toMatchObject({
      outcome: "partial",
      missingFiles: 0,
      archive: { sha256: ARCHIVE },
    });
    expect(
      projectExportHistoryRecord(record(receipt({ status: "failed" })), TEAM),
    ).toMatchObject({
      outcome: "failed",
      archive: { sha256: ARCHIVE },
    });
  });

  test("refuses a foreign row even if its receipt uses the requested team's path", () => {
    expect(() =>
      projectExportHistoryRecord(
        {
          ...record(),
          team_id: "33333333-3333-4333-8333-333333333333",
        },
        TEAM,
      ),
    ).toThrow("Invalid export snapshot metadata");
  });

  test("bad snapshot metadata never exposes a purported archive", () => {
    for (const value of ["2026-02-30T12:00:00.000Z", "private note", null]) {
      expect(
        projectExportHistoryRecord({ ...record(), snapshot_at: value }, TEAM)
          .archive,
      ).toBeNull();
    }
  });

  test("bounds page size and requires the lossless timestamp cursor", () => {
    expect(validateExportHistoryPage({})).toBe(10);
    expect(
      validateExportHistoryPage({
        limit: 25,
        cursor: { id: ID, createdAt: record().created_at },
      }),
    ).toBe(25);
    for (const limit of [0, -1, 26, 1.5, Number.NaN]) {
      expect(() => validateExportHistoryPage({ limit })).toThrow();
    }
    for (const createdAt of [
      "2026-11-03T12:00:00.000Z",
      "2026-02-30T12:00:00.000001Z",
      "private",
    ]) {
      expect(() =>
        validateExportHistoryPage({ cursor: { id: ID, createdAt } }),
      ).toThrow();
    }
  });
});
