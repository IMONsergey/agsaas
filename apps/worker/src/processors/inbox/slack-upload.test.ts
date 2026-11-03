import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Socket } from "node:net";
import type { Job } from "bullmq";
import type { SlackUploadPayload } from "../../schemas/inbox";

// Run in its own Bun process: actual processor, in-memory external boundaries.
const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
let networkAttempts = 0;
const forbidNetwork = (): never => {
  networkAttempts++;
  throw new Error("External IO is forbidden in the Slack receipt regression");
};
globalThis.fetch = Object.assign(async () => forbidNetwork(), {
  preconnect: forbidNetwork,
});
Socket.prototype.connect = forbidNetwork;

const teamId = "494c4720-6bf3-41b2-820d-59ce91414893";
const inboxId = "b81e124e-4e6b-4e29-97cd-e94010bccfed";
const canonicalPath = [teamId, "receipts", "canonical.pdf"];
const freshPath = [teamId, "receipts", "fresh.png"];
const originalBytes = Buffer.from("%PDF-1.7 original stored receipt");
const freshBytes = Buffer.from("a later Slack delivery");
let storedPath: string[] | null = canonicalPath;
const objects = new Map<string, Buffer>();
const events: string[] = [];
const queued: Array<{ name: string; payload: unknown; queue: string }> = [];
const signedPaths: string[] = [];
const downloadedPaths: string[] = [];

const bucket = {
  upload: async (path: string, bytes: Uint8Array) => {
    events.push(`upload:${path}`);
    objects.set(path, Buffer.from(bytes));
    return { data: { path }, error: null };
  },
  remove: async (paths: string[]) => {
    for (const path of paths) {
      events.push(`remove:${path}`);
      objects.delete(path);
    }
    return { error: null };
  },
  createSignedUrl: async (path: string) => {
    events.push(`sign:${path}`);
    signedPaths.push(path);
    if (!objects.has(path))
      throw new Error("Signing a removed or missing receipt");
    return {
      data: { signedUrl: `https://storage.example.test/vault/${path}` },
      error: null,
    };
  },
  download: async (path: string) => {
    events.push(`download:${path}`);
    downloadedPaths.push(path);
    const bytes = objects.get(path);
    if (!bytes) throw new Error("Downloading a removed or missing receipt");
    return bytes;
  },
};
const createInbox = mock(async (_db: unknown, _input: unknown) => {
  events.push("inbox-reference");
  return { id: inboxId, filePath: storedPath, contentType: "application/pdf" };
});
const extract = mock(
  async (task: { request: { documentUrl: string; mimetype: string } }) => {
    const path = new URL(task.request.documentUrl).pathname.slice(
      "/vault/".length,
    );
    const bytes = await bucket.download(path);
    expect(bytes).toEqual(originalBytes);
    expect(task.request.mimetype).toBe("application/pdf");
    return { document_type: "invoice", type: "invoice" };
  },
);
const downloadFile = mock(
  async (_input: { privateDownloadUrl: string; token: string }) => freshBytes,
);

mock.module("@midday/app-store/slack-client", () => ({
  downloadFile,
  ensureBotInChannel: async () => {},
  createSlackWebClient: () => ({
    reactions: { add: async () => {}, remove: async () => {} },
    conversations: { history: async () => ({ messages: [] }) },
    chat: {
      postMessage: async () => {
        throw new Error("No outbound Slack message is expected");
      },
    },
  }),
}));
mock.module("@midday/db/queries", () => ({
  createInbox,
  groupRelatedInboxItems: async () => {},
  updateInbox: async () => {},
  updateInboxWithProcessedData: async () => ({ id: inboxId, amount: null }),
}));
mock.module("@midday/supabase/job", () => ({
  createTeamClient: (scope: string) => {
    expect(scope).toBe(teamId);
    return {
      storage: {
        from: (name: string) => {
          expect(name).toBe("vault");
          return bucket;
        },
      },
    };
  },
}));
mock.module("@midday/job-client", () => ({
  triggerJob: async (name: string, payload: unknown, queue: string) => {
    events.push(`queue:${name}`);
    queued.push({ name, payload, queue });
  },
}));
mock.module("@midday/utils", () => ({
  getExtensionFromMimeType: () => ".png",
}));
mock.module("@midday/utils/receipt-path", () => ({
  createReceiptObjectPath: () => [...freshPath],
  createReceiptReferenceId: async () => "fixture-receipt-reference",
}));
mock.module("../../utils/db", () => ({ getDb: () => ({}) }));
mock.module("../../utils/document-isolation", () => ({
  runDocumentTask: extract,
}));
mock.module("@ai-sdk/openai", () => ({
  openai: () => {
    throw new Error("AI provider is forbidden in this regression");
  },
}));
mock.module("ai", () => ({
  generateText: async () => {
    throw new Error("AI generation is forbidden in this regression");
  },
}));
mock.module("../base", () => ({
  BaseProcessor: class {
    logger = {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    };
  },
}));

const { SlackUploadProcessor } = await import("./slack-upload");
const payload: SlackUploadPayload = {
  teamId,
  token: "fixture-slack-token",
  channelId: "fixture-channel",
  messageTs: "1730000000.001",
  file: {
    id: "fixture-file",
    name: "redelivery.png",
    mimetype: "image/png",
    size: 99999,
    url: "https://files.example.test/private-fixture",
  },
};
// process() reads only job.data; queue lifecycle is covered by the BaseProcessor suites.
const job = { data: payload } as Job<SlackUploadPayload>;

beforeEach(() => {
  networkAttempts = 0;
  objects.clear();
  objects.set(canonicalPath.join("/"), originalBytes);
  storedPath = [...canonicalPath];
  events.length = 0;
  queued.length = 0;
  signedPaths.length = 0;
  downloadedPaths.length = 0;
  createInbox.mockClear();
  downloadFile.mockClear();
  extract.mockClear();
});
afterEach(() => expect(networkAttempts).toBe(0));
afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
});

describe("Slack duplicate receipt canonical file", () => {
  test("signs, downloads and queues the stored receipt after deleting the fresh duplicate", async () => {
    await new SlackUploadProcessor().process(job);
    const canonical = canonicalPath.join("/");
    const fresh = freshPath.join("/");
    expect(downloadFile).toHaveBeenCalledWith({
      privateDownloadUrl: payload.file.url,
      token: payload.token,
    });
    expect(createInbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filePath: freshPath,
        size: freshBytes.byteLength,
        teamId,
      }),
    );
    expect(objects.has(fresh)).toBe(false);
    expect(objects.get(canonical)).toEqual(originalBytes);
    expect(events).toContain(`upload:${fresh}`);
    expect(events).toContain(`remove:${fresh}`);
    expect(events.indexOf(`remove:${fresh}`)).toBeLessThan(
      events.indexOf(`sign:${canonical}`),
    );
    expect(signedPaths).toEqual([canonical]);
    expect(downloadedPaths).toEqual([canonical]);
    expect(queued).toContainEqual({
      name: "process-document",
      queue: "documents",
      payload: { teamId, filePath: canonicalPath, mimetype: "application/pdf" },
    });
    expect(queued).toContainEqual({
      name: "batch-process-matching",
      queue: "inbox",
      payload: { teamId, inboxIds: [inboxId] },
    });
  });

  test("a missing stored reference cannot fall back to the unreferenced new upload", async () => {
    storedPath = null;
    await expect(new SlackUploadProcessor().process(job)).rejects.toThrow(
      "Invalid storage key",
    );
    expect(signedPaths).toEqual([]);
    expect(downloadedPaths).toEqual([]);
    expect(extract).not.toHaveBeenCalled();
    expect(queued).toEqual([]);
  });
});
