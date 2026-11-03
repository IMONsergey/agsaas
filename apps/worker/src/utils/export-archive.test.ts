import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildExportManifest,
  collectExportAssets,
  exportOperationKey,
  exportOutcome,
  safeCsvCell,
  sha256,
  storeImmutableExport,
  zipExportFiles,
} from "./export-archive";

const teamId = "40000000-0000-4000-8000-000000000001";
const otherTeam = "40000000-0000-4000-8000-000000000002";
function storage() {
  const objects = new Map<string, Buffer>();
  let reads = 0;
  const client = {
    storage: {
      from: () => ({
        upload: async (
          key: string,
          value: Buffer,
          options: { upsert: boolean },
        ) => {
          expect(options.upsert).toBe(false);
          if (objects.has(key)) return { error: { message: "exists" } };
          objects.set(key, value);
          return { error: null };
        },
        download: async (key: string) => {
          reads++;
          if (key.endsWith("throw")) throw new Error("fixture timeout");
          const value = objects.get(key);
          return value
            ? { data: new Blob([Uint8Array.from(value)]), error: null }
            : { data: null, error: { statusCode: 404 } };
        },
      }),
    },
  };
  return { client: client as never, objects, reads: () => reads };
}

describe("immutable export archives and completeness", () => {
  test("parallel exports in the same millisecond cannot overwrite one another; replay retains the same object", async () => {
    const f = storage();
    const zip = await zipExportFiles(
      [{ name: "data.json", data: Buffer.from("{}") }],
      "2026-11-03T00:00:00.000Z",
    );
    const opA = exportOperationKey(teamId, {
      id: "a",
      name: "export-transactions",
    });
    const opB = exportOperationKey(teamId, {
      id: "b",
      name: "export-transactions",
    });
    const [a, b] = await Promise.all([
      storeImmutableExport(f.client, { teamId, operationId: opA, zip }),
      storeImmutableExport(f.client, { teamId, operationId: opB, zip }),
    ]);
    expect(a.fullPath).not.toBe(b.fullPath);
    expect(f.objects.size).toBe(2);
    expect(
      await storeImmutableExport(f.client, { teamId, operationId: opA, zip }),
    ).toEqual(a);
    expect(f.objects.size).toBe(2);
    const repeated = await zipExportFiles(
      [{ name: "data.json", data: Buffer.from("{}") }],
      "2026-11-03T00:00:00.000Z",
    );
    expect(sha256(repeated)).toBe(sha256(zip));
    f.objects.set(a.fullPath, Buffer.from("corrupted fixture"));
    await expect(
      storeImmutableExport(f.client, { teamId, operationId: opA, zip }),
    ).rejects.toThrow("not verified");
    expect(f.objects.get(a.fullPath)?.toString()).toBe("corrupted fixture");
  });

  test("a failed generated-file authorization stops before every Storage call", async () => {
    const f = storage();
    const zip = Buffer.from("fixture archive");
    const operationId = "a".repeat(64);
    let authorizedPath = "";
    let authorizedBytes = 0;
    await expect(
      storeImmutableExport(f.client, {
        teamId,
        operationId,
        zip,
        beforeUpload: async (path, bytes) => {
          authorizedPath = path;
          authorizedBytes = bytes;
          throw new Error("fixture admission denied");
        },
      }),
    ).rejects.toThrow("fixture admission denied");
    expect(authorizedPath).toBe(
      `${teamId}/exports/${operationId}/${sha256(zip)}.zip`,
    );
    expect(authorizedBytes).toBe(zip.length);
    expect(f.objects.size).toBe(0);
    expect(f.reads()).toBe(0);
  });

  test("missing, thrown and corrupt files yield partial receipts and never mark their transactions complete", async () => {
    const f = storage();
    f.objects.set(`${teamId}/good`, Buffer.from("good"));
    f.objects.set(`${teamId}/bad-pdf`, Buffer.from("not a PDF"));
    f.objects.set(`${teamId}/size`, Buffer.from("changed"));
    const result = await collectExportAssets(f.client, teamId, [
      {
        id: "a",
        transactionId: "tx-a",
        path: [teamId, "good"],
        name: "a",
        size: 4,
      },
      { id: "b", transactionId: "tx-b", path: [teamId, "404"], name: "b" },
      { id: "c", transactionId: "tx-c", path: [teamId, "throw"], name: "c" },
      {
        id: "d",
        transactionId: "tx-d",
        path: [teamId, "bad-pdf"],
        name: "d",
        contentType: "application/pdf",
      },
      {
        id: "e",
        transactionId: "tx-e",
        path: [teamId, "size"],
        name: "e",
        size: 5,
      },
    ]);
    expect(result.files.map((file) => file.name)).toEqual(["a"]);
    expect(result.receipts.map((item) => item.status)).toEqual([
      "included",
      "missing",
      "missing",
      "invalid",
      "invalid",
    ]);
    const ids = ["tx-a", "tx-b", "tx-c", "tx-d", "tx-e"];
    const outcome = exportOutcome(
      [...ids, "missing-row"],
      ids,
      result.receipts,
    );
    expect(outcome.status).toBe("partial");
    expect(outcome.completeIds).toEqual(["tx-a"]);
    expect(outcome.missingRows).toEqual(["missing-row"]);
    expect(exportOutcome(["missing-row"], [], []).status).toBe("failed");
    expect(outcome.missingFiles).toBe(4);
  });

  test("a foreign path anywhere in the batch fails before the first download", async () => {
    const f = storage();
    await expect(
      collectExportAssets(f.client, teamId, [
        { id: "valid", path: [teamId, "good"], name: "valid" },
        { id: "foreign", path: [otherTeam, "private"], name: "foreign" },
      ]),
    ).rejects.toThrow();
    expect(f.reads()).toBe(0);
  });

  for (const reservedPath of [
    [teamId, "exports", "team-export-2026-11-03.zip"],
    [teamId, "exports", "a".repeat(64), `${"b".repeat(64)}.zip`],
  ]) {
    test(`cannot embed reserved export bytes from ${reservedPath.slice(1).join("/")}`, async () => {
      const f = storage();
      f.objects.set(
        reservedPath.join("/"),
        Buffer.from("private full-team archive"),
      );
      const result = await collectExportAssets(f.client, teamId, [
        {
          id: "reserved",
          transactionId: "tx-reserved",
          path: reservedPath,
          name: "attachments/disguised-receipt.zip",
          contentType: "application/zip",
        },
      ]);
      expect(f.reads()).toBe(0);
      expect(result.files).toEqual([]);
      expect(result.receipts).toEqual([
        {
          id: "reserved",
          transactionId: "tx-reserved",
          source: reservedPath.join("/"),
          name: "attachments/disguised-receipt.zip",
          status: "invalid",
          reason: "reserved_export_artifact",
        },
      ]);
      expect(
        exportOutcome(["tx-reserved"], ["tx-reserved"], result.receipts),
      ).toMatchObject({
        status: "partial",
        missingFiles: 1,
        completeIds: [],
      });
    });
  }

  test("manifest hashes identify actual bytes and archive names cannot collide", async () => {
    const files = [{ name: "data.json", data: Buffer.from("[]") }];
    const manifest = buildExportManifest({
      operationId: "op",
      snapshotId: "snapshot",
      snapshotHash: "hash",
      asOf: "2026-11-03",
      status: "complete",
      tables: { invoices: [{ id: "invoice" }] },
      files,
      assets: [],
      missingRows: [],
      omissions: [],
    });
    expect(manifest.tableCounts.invoices).toBe(1);
    expect(manifest.files[0]).toEqual({
      path: "data.json",
      bytes: 2,
      sha256: sha256("[]"),
    });
    await expect(
      zipExportFiles([...files, ...files], "2026-11-03"),
    ).rejects.toThrow("Duplicate");
    await expect(
      zipExportFiles(
        [{ name: "../outside", data: Buffer.from("x") }],
        "2026-11-03",
      ),
    ).rejects.toThrow("unsafe");
  });
});

describe("CSV safe text", () => {
  test("formula-like user strings including controls are escaped, JSON can retain originals", () => {
    for (const value of [
      "=1+1",
      "+1",
      "-2+3",
      "@SUM(A1)",
      "  =1",
      "\t=1",
      "\u0000+1",
      "\ufeff=1",
      "\rhello",
    ]) {
      expect(safeCsvCell(value)).toBe(`'${value}`);
      expect(JSON.parse(JSON.stringify({ value })).value).toBe(value);
    }
    expect(safeCsvCell(-123.45)).toBe(-123.45);
    expect(safeCsvCell(0)).toBe(0);
    expect(safeCsvCell("ordinary, quoted text")).toBe("ordinary, quoted text");
  });
});

test("independent offline verifier accepts intact archives and rejects altered data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agsaas-export-proof-"));
  try {
    const snapshot = {
      version: 1,
      asOf: "2026-11-03T00:00:00.000Z",
      tables: { invoices: [{ id: "fixture" }] },
    };
    const files = [
      {
        name: "data/snapshot.json",
        data: Buffer.from(JSON.stringify(snapshot)),
      },
    ];
    const manifest = buildExportManifest({
      operationId: "fixture",
      snapshotId: "fixture",
      snapshotHash: "fixture",
      asOf: snapshot.asOf,
      status: "complete",
      tables: snapshot.tables,
      files,
      assets: [],
      missingRows: [],
      omissions: [],
    });
    const manifestFile = {
      name: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest)),
    };
    const target = join(dir, "export.zip");
    const verifier = fileURLToPath(
      new URL("../../../../scripts/verify-export-archive.py", import.meta.url),
    );
    await writeFile(
      target,
      await zipExportFiles([...files, manifestFile], snapshot.asOf),
    );
    const accepted = Bun.spawn(["python3", verifier, target], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await accepted.exited).toBe(0);
    expect(
      JSON.parse(await new Response(accepted.stdout).text()).verified,
    ).toBe(true);
    await writeFile(
      target,
      await zipExportFiles(
        [{ name: "data/snapshot.json", data: Buffer.from("{}") }, manifestFile],
        snapshot.asOf,
      ),
    );
    const rejected = Bun.spawn(["python3", verifier, target], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await rejected.exited).toBe(1);
    expect(
      JSON.parse(await new Response(rejected.stderr).text()).verified,
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
