import { describe, expect, it } from "bun:test";
import {
  type StoredExportArchiveReceipt,
  validateExportArchiveReceipt,
} from "../export-archive-receipt";

const team = "11111111-1111-4111-8111-111111111111";
const otherTeam = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const op = "a".repeat(64);
const snapshotHash = "b".repeat(64);
const archiveHash = "c".repeat(64);
const path = `${team}/exports/${op}/${archiveHash}.zip`;
const at = "2026-11-03T12:34:56.789Z";

function receipt(
  kind: "team" | "transactions" = "team",
): StoredExportArchiveReceipt {
  return {
    id,
    team_id: team,
    operation_key: op,
    snapshot_hash: snapshotHash,
    snapshot_kind: kind,
    snapshot_version: "1",
    snapshot_at: at,
    result: {
      operationId: op,
      snapshotId: id,
      snapshotHash,
      archiveHash,
      fullPath: path,
      status: "complete",
      totalItems: 12,
      missingFiles: 0,
      // Arbitrary stored fields cannot escape this projection.
      credentials: "private-fixture",
      snapshot: { transactionRows: ["private-fixture"] },
      fileName: "untrusted-name.zip",
    },
  };
}

function withResult(fields: Record<string, unknown>) {
  const row = receipt();
  row.result = { ...(row.result as Record<string, unknown>), ...fields };
  return row;
}

describe("immutable export archive receipt validation", () => {
  for (const kind of ["team", "transactions"] as const) {
    it(`binds a ${kind} archive and returns only validated metadata`, () => {
      expect(validateExportArchiveReceipt(receipt(kind), team)).toEqual({
        kind,
        status: "complete",
        totalItems: 12,
        missingFiles: 0,
        path,
        sha256: archiveHash,
        snapshotAt: at,
      });
    });
  }

  for (const status of ["partial", "failed"] as const) {
    it(`preserves a ${status} diagnostic artifact with zero missing files`, () => {
      expect(
        validateExportArchiveReceipt(withResult({ status }), team),
      ).toMatchObject({
        status,
        missingFiles: 0,
        path,
      });
    });
  }

  for (const [label, result] of [
    ["SQL null", null],
    ["array", []],
    ["primitive", "private-fixture"],
  ] as const) {
    it(`rejects a ${label} receipt`, () => {
      expect(
        validateExportArchiveReceipt({ ...receipt(), result }, team),
      ).toBeNull();
    });
  }

  for (const [label, fields] of [
    ["operation", { operationId: "d".repeat(64) }],
    ["snapshot ID", { snapshotId: otherTeam }],
    ["snapshot hash", { snapshotHash: "d".repeat(64) }],
    ["archive hash", { archiveHash: "C".repeat(64) }],
    ["numeric archive hash", { archiveHash: 123 }],
    ["foreign path", { fullPath: path.replace(team, otherTeam) }],
    ["path suffix", { fullPath: `${path}?download=true` }],
    ["wrong operation path", { fullPath: path.replace(op, "d".repeat(64)) }],
    ["unknown status", { status: "queued" }],
    ["incomplete complete", { missingFiles: 1 }],
    ["negative count", { totalItems: -1 }],
    ["fractional count", { totalItems: 1.5 }],
    ["unsafe count", { totalItems: Number.MAX_SAFE_INTEGER + 1 }],
    ["not-a-number count", { missingFiles: Number.NaN }],
    ["infinite count", { missingFiles: Number.POSITIVE_INFINITY }],
  ] as const) {
    it(`rejects an invalid ${label}`, () => {
      expect(validateExportArchiveReceipt(withResult(fields), team)).toBeNull();
    });
  }

  for (const [label, fields] of [
    ["foreign team", { team_id: otherTeam }],
    ["noncanonical ID", { id: "invalid" }],
    ["row operation", { operation_key: "A".repeat(64) }],
    ["row hash", { snapshot_hash: "B".repeat(64) }],
    ["snapshot kind", { snapshot_kind: "files" }],
    ["snapshot version", { snapshot_version: "2" }],
    ["missing snapshot time", { snapshot_at: null }],
    ["invalid calendar date", { snapshot_at: "2026-02-30T12:34:56.789Z" }],
    ["noncanonical time", { snapshot_at: "2026-11-03T12:34:56Z" }],
  ] as const) {
    it(`rejects ${label} before exposing an archive`, () => {
      expect(
        validateExportArchiveReceipt({ ...receipt(), ...fields }, team),
      ).toBeNull();
    });
  }

  it("does not use the stored row team as caller authority", () => {
    expect(validateExportArchiveReceipt(receipt(), otherTeam)).toBeNull();
  });
});
