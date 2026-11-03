import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import type { Job } from "bullmq";
import type { ProcessAttachmentPayload } from "../../schemas/inbox";

// Run in a fresh Bun process: actual processor, fake external boundaries.
const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error("Unexpected external IO in erasure regression");
};
globalThis.fetch = Object.assign(async () => forbidden(), {
  preconnect: forbidden,
});
Socket.prototype.connect = forbidden;
afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
});
const teamId = "072444d1-c445-43ed-9d34-ad8957a8f349";
const inboxId = "77d79770-14a1-4da9-8fd3-02db3b5ec725";
const filePath = [teamId, "inbox", "receipt.bin"];
const events: string[] = [];
let deleted = false;
let eraseAt: "none" | "create" | "sign" | "extract" | "persist" | "group" =
  "none";
let existing = true;
const db = {
  usePrimaryOnly() {
    return this;
  },
};
const row = () => ({
  id: inboxId,
  filePath,
  status: "processing",
  displayName: "Fixture",
  createdAt: "2026-11-03T00:00:00.000Z",
  contentType: "application/pdf",
});
class DeletedReceipt extends Error {}

mock.module("../base", () => ({
  BaseProcessor: class {
    logger = { info() {}, warn() {}, error() {} };
  },
}));
mock.module("../../utils/db", () => ({ getDb: () => db }));
mock.module("@midday/db/queries/inbox-deletion-receipts", () => ({
  InboxReceiptDeletedError: DeletedReceipt,
  isInboxReceiptDeleted: async (
    actualDb: unknown,
    scope: { teamId: string; filePath: string[] },
  ) => {
    expect(actualDb).toBe(db);
    expect(scope.teamId).toBe(teamId);
    expect(scope.filePath).toEqual(filePath);
    return deleted;
  },
}));
mock.module("@midday/db/queries", () => ({
  assertInboxUploadScope: async () => {
    events.push("scope");
  },
  getInboxByFilePath: async () => {
    events.push("lookup");
    return existing ? row() : undefined;
  },
  createInbox: async () => {
    events.push("create");
    if (eraseAt === "create") {
      deleted = true;
      throw new DeletedReceipt();
    }
    return row();
  },
  getTeamById: async () => ({ name: "Fixture" }),
  updateInboxWithProcessedData: async (_db: unknown, data: unknown) => {
    events.push("persist");
    if (eraseAt === "persist") {
      deleted = true;
      return undefined;
    }
    expect(deleted).toBe(false);
    return data;
  },
  updateInbox: async () => {
    events.push("fallback-update");
  },
  groupRelatedInboxItems: async () => {
    events.push("group");
    if (eraseAt === "group") deleted = true;
  },
}));
mock.module("@midday/supabase/job", () => ({
  createTeamClient: () => {
    events.push("client");
    return {
      storage: {
        from: () => ({
          createSignedUrl: async () => {
            events.push("sign");
            if (eraseAt === "sign") deleted = true;
            return {
              data: { signedUrl: "https://storage.example.test/fixture" },
            };
          },
          download: async () => {
            events.push("download");
            return { data: new Blob(["fixture"]) };
          },
        }),
      },
    };
  },
}));
mock.module("../../utils/image-processing", () => ({
  convertHeicToJpeg: async () => {
    events.push("convert");
    return { buffer: Buffer.from("converted") };
  },
}));
mock.module("../../utils/document-isolation", () => ({
  runDocumentTask: async () => {
    events.push("extract");
    if (eraseAt === "extract") deleted = true;
    return {
      type: "invoice",
      document_type: "invoice",
      name: "Sensitive extracted name",
      amount: 19.95,
      currency: "USD",
    };
  },
}));
mock.module("@midday/job-client", () => ({
  triggerJob: async (name: string) => {
    events.push("queue:" + name);
    return { id: "fake-" + name };
  },
}));
const { ProcessAttachmentProcessor } = await import("./process-attachment");
function job(mimetype = "application/pdf") {
  return {
    id: "fixture-process",
    data: {
      teamId,
      mimetype,
      size: 7,
      filePath,
      referenceId: "fixture-reference",
    },
  } as Job<ProcessAttachmentPayload>;
}
beforeEach(() => {
  deleted = false;
  existing = true;
  eraseAt = "none";
  events.length = 0;
});

describe("process-attachment erasure fence", () => {
  test("already erased HEIC never creates a client, downloads, converts or extracts", async () => {
    deleted = true;
    await new ProcessAttachmentProcessor().process(job("image/heic"));
    expect(events).toEqual([]);
  });
  test("erasure between the precheck and registration never recreates or signs the receipt", async () => {
    existing = false;
    eraseAt = "create";
    await new ProcessAttachmentProcessor().process(job());
    expect(events).toContain("create");
    expect(
      events.some((value) => ["sign", "extract", "persist"].includes(value)),
    ).toBe(false);
  });
  for (const stage of ["sign", "extract", "persist", "group"] as const) {
    test(
      "a concurrent erasure at " +
        stage +
        " prevents subsequent output/handoff",
      async () => {
        eraseAt = stage;
        await new ProcessAttachmentProcessor().process(job());
        expect(events.some((value) => value.startsWith("queue:"))).toBe(false);
        expect(events).not.toContain("fallback-update");
        if (stage === "sign") expect(events).not.toContain("extract");
        if (stage === "sign" || stage === "extract")
          expect(events).not.toContain("persist");
        if (stage !== "group") expect(events).not.toContain("group");
      },
    );
  }
  test("a live receipt still persists and hands off document processing and matching", async () => {
    await new ProcessAttachmentProcessor().process(job());
    expect(events).toContain("extract");
    expect(events).toContain("persist");
    expect(events).toContain("queue:process-document");
    expect(events).toContain("queue:batch-process-matching");
  });
});
