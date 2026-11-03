import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Job } from "bullmq";
import type { AccountingAttachmentSyncPayload } from "../../schemas/accounting";
import type { ProcessTransactionAttachmentPayload } from "../../schemas/transactions";

const teamId = "11111111-1111-4111-8111-111111111111";
const otherTeam = "22222222-2222-4222-8222-222222222222";
const attachmentId = "33333333-3333-4333-8333-333333333333";
const transactionId = "44444444-4444-4444-8444-444444444444";
const syncRecordId = "55555555-5555-4555-8555-555555555555";
const current = [teamId, "exports", "a".repeat(64), "b".repeat(64) + ".zip"];
const legacy = [teamId, "exports", "team-export-2026-11-03.zip"];
const ordinary = [teamId, "transactions", "receipt.pdf"];

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const db = {};
let attachmentPath: string[] = current;
const download = mock(async (_path: string) => ({
  data: new Blob(["%PDF-fixture"], { type: "application/pdf" }),
  error: null,
}));
const sign = mock(async (_path: string, _ttl: number) => ({
  data: { signedUrl: "https://storage.fixture.invalid/ordinary" },
  error: null,
}));
const upload = mock(async () => ({ data: {}, error: null }));
const storageFrom = mock((_bucket: string) => ({
  download,
  createSignedUrl: sign,
  upload,
}));
const createTeamClient = mock((_teamId: string) => ({
  storage: { from: storageFrom },
}));
const providerUpload = mock(async () => ({
  success: true,
  attachmentId: "provider-attachment-fixture",
}));
const updateMapping = mock(async () => {});
const assertScope = mock(async () => {});
const updateTransaction = mock(async () => {});
const triggerJob = mock(async () => ({ id: "fixture-job" }));
const getInvoiceOrReceipt = mock(async () => ({
  tax_rate: null,
  tax_type: null,
}));
const convert = mock(async () => ({ buffer: Buffer.from("unused") }));

mock.module("@midday/supabase/job", () => ({ createTeamClient }));
mock.module("@midday/db/queries", () => ({
  getAccountingSyncStatus: async () => [],
  getTransactionAttachmentsForSync: async () => [
    {
      id: attachmentId,
      // Spoofing PDF name/type must not grant access to actual ZIP bytes.
      name: "receipt.pdf",
      type: "application/pdf",
      path: attachmentPath,
    },
  ],
  updateSyncedAttachmentMapping: updateMapping,
  assertTransactionAttachmentScope: assertScope,
  updateTransaction,
}));
mock.module("@midday/job-client", () => ({ triggerJob }));
mock.module("@midday/documents", () => ({
  DocumentClient: class {
    getInvoiceOrReceipt = getInvoiceOrReceipt;
  },
}));
mock.module("../../utils/db", () => ({ getDb: () => db }));
mock.module("../../utils/image-processing", () => ({
  convertHeicToJpeg: convert,
}));
// Only external initialization, queue plumbing and telemetry are replaced.
// Both production processor bodies, path validation, MIME resolution and
// failure/mapping aggregation execute unchanged.
mock.module("../accounting/base", () => ({
  AccountingProcessorBase: class {
    logger = logger;
    async initializeProvider() {
      return { provider: { uploadAttachment: providerUpload }, config: {}, db };
    }
    getOrgIdFromConfig() {
      return "fixture-org";
    }
    async updateProgress() {}
  },
}));
mock.module("../base", () => ({
  BaseProcessor: class {
    logger = logger;
  },
}));

const { SyncAttachmentsProcessor } = await import(
  "../accounting/sync-attachments"
);
const { ProcessTransactionAttachmentProcessor } = await import(
  "./process-attachment"
);

function accountingJob() {
  return {
    data: {
      teamId,
      providerId: "xero",
      transactionId,
      providerTransactionId: "provider-transaction-fixture",
      attachmentIds: [attachmentId],
      syncRecordId,
    },
  } as Job<AccountingAttachmentSyncPayload>;
}

function processingJob(filePath: string[], mimetype: string) {
  return {
    data: { teamId, transactionId, filePath, mimetype },
  } as Job<ProcessTransactionAttachmentPayload>;
}

beforeEach(() => {
  attachmentPath = current;
  for (const fn of [
    download,
    sign,
    upload,
    storageFrom,
    createTeamClient,
    providerUpload,
    updateMapping,
    assertScope,
    updateTransaction,
    triggerJob,
    getInvoiceOrReceipt,
    convert,
  ])
    fn.mockClear();
});

describe("transaction attachment exports cannot bypass reserved archive authority", () => {
  for (const [label, path] of [
    ["current", current],
    ["legacy", legacy],
  ] as const) {
    test(
      "accounting marks " +
        label +
        " export attachments partial before any byte read or provider upload",
      async () => {
        attachmentPath = [...path];
        const result = await new SyncAttachmentsProcessor().process(
          accountingJob(),
        );
        expect(result).toMatchObject({
          uploadedCount: 0,
          failedCount: 1,
          deletedCount: 0,
        });
        expect(storageFrom).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
        expect(providerUpload).not.toHaveBeenCalled();
        expect(updateMapping).toHaveBeenCalledWith(db, {
          syncRecordId,
          syncedAttachmentMapping: {},
          status: "partial",
          errorMessage:
            "Export archives cannot be synced as transaction attachments",
          errorCode: "ATTACHMENT_RESERVED_EXPORT",
        });
      },
    );

    for (const mimetype of ["application/pdf", "image/heic"]) {
      test(
        "OCR refuses " +
          label +
          " reserved export with " +
          mimetype +
          " metadata before any Storage or document call",
        async () => {
          await expect(
            new ProcessTransactionAttachmentProcessor().process(
              processingJob([...path], mimetype),
            ),
          ).rejects.toThrow(
            "Export archives cannot be processed as transaction attachments",
          );
          expect(createTeamClient).not.toHaveBeenCalled();
          expect(storageFrom).not.toHaveBeenCalled();
          expect(sign).not.toHaveBeenCalled();
          expect(download).not.toHaveBeenCalled();
          expect(convert).not.toHaveBeenCalled();
          expect(getInvoiceOrReceipt).not.toHaveBeenCalled();
          expect(triggerJob).not.toHaveBeenCalled();
          expect(updateTransaction).not.toHaveBeenCalled();
        },
      );
    }
  }

  test("accounting also rejects a foreign attachment before Storage without changing its mapping to success", async () => {
    attachmentPath = [otherTeam, "transactions", "receipt.pdf"];
    const result = await new SyncAttachmentsProcessor().process(
      accountingJob(),
    );
    expect(result).toMatchObject({ uploadedCount: 0, failedCount: 1 });
    expect(storageFrom).not.toHaveBeenCalled();
    expect(providerUpload).not.toHaveBeenCalled();
    expect(updateMapping).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        status: "partial",
        syncedAttachmentMapping: {},
        errorCode: "ATTACHMENT_INVALID_SOURCE",
      }),
    );
  });

  test("ordinary accounting attachments retain download, upload and successful exact mapping", async () => {
    attachmentPath = ordinary;
    const result = await new SyncAttachmentsProcessor().process(
      accountingJob(),
    );
    expect(result).toMatchObject({ uploadedCount: 1, failedCount: 0 });
    expect(download).toHaveBeenCalledWith(ordinary.join("/"));
    expect(providerUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "fixture-org",
        fileName: "receipt.pdf",
        mimeType: "application/pdf",
        content: Buffer.from("%PDF-fixture"),
      }),
    );
    expect(updateMapping).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        status: "synced",
        syncedAttachmentMapping: {
          [attachmentId]: "provider-attachment-fixture",
        },
      }),
    );
  });

  test("ordinary OCR attachments retain the exact relational scope check and signed document path", async () => {
    await new ProcessTransactionAttachmentProcessor().process(
      processingJob(ordinary, "application/pdf"),
    );
    expect(assertScope).toHaveBeenCalledWith(db, teamId, [
      {
        filePath: ordinary,
        transactionId,
      },
    ]);
    expect(sign).toHaveBeenCalledWith(ordinary.join("/"), 600);
    expect(getInvoiceOrReceipt).toHaveBeenCalledWith({
      documentUrl: "https://storage.fixture.invalid/ordinary",
      mimetype: "application/pdf",
    });
    expect(triggerJob).toHaveBeenCalledWith(
      "process-document",
      {
        mimetype: "application/pdf",
        filePath: ordinary,
        teamId,
      },
      "documents",
    );
    expect(download).not.toHaveBeenCalled();
  });
});
