import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createInboxWebhookPostSchema } from "../../../../packages/inbox/src/schema";
import { getInboxIdFromEmail } from "../../../../packages/inbox/src/utils";
import type { Context } from "../rest/types";
import type {
  InboxWebhookReceipt,
  WebhookAttachment,
} from "../services/inbox-webhook-ingestion";

const teamId = "30000000-0000-4000-8000-000000000003";
const environmentNames = [
  "NODE_ENV",
  "INBOX_DOMAIN",
  "NEXT_PUBLIC_INBOX_DOMAIN",
  "INBOX_WEBHOOK_USERNAME",
  "INBOX_WEBHOOK_PASSWORD",
] as const;
const prior = new Map(environmentNames.map((key) => [key, process.env[key]]));
process.env.NODE_ENV = "test";
process.env.INBOX_DOMAIN = "inbox.example.test";
delete process.env.NEXT_PUBLIC_INBOX_DOMAIN;
delete process.env.INBOX_WEBHOOK_USERNAME;
delete process.env.INBOX_WEBHOOK_PASSWORD;

const objects = new Map<string, Uint8Array>();
const rows = new Map<string, InboxWebhookReceipt>();
const queued = new Map<string, string[]>();
const refusedBytes = new Set<string>();
const options: unknown[] = [];
let rejectQueue = false;
let lostStorageResponse = false;
let clientIp = "3.134.147.250";
const storage = {
  upload: async (path: string, bytes: Uint8Array, opts: unknown) => {
    options.push(opts);
    if (refusedBytes.has(Buffer.from(bytes).toString()))
      return { data: null, error: { message: "fixture outage" } };
    if (objects.has(path))
      return { data: null, error: { message: "already exists" } };
    objects.set(path, new Uint8Array(bytes));
    if (lostStorageResponse) throw new Error("upload committed, response lost");
    return { data: { path }, error: null };
  },
  download: async (path: string) => {
    const bytes = objects.get(path);
    return bytes
      ? { data: new Blob([new Uint8Array(bytes)]), error: null }
      : { data: null, error: { message: "missing" } };
  },
};
const register = mock(async (_db: unknown, input: Record<string, unknown>) => {
  const ref = String(input.referenceId);
  if (!rows.has(ref))
    rows.set(ref, {
      ...(input as unknown as InboxWebhookReceipt),
      id: crypto.randomUUID(),
      senderEmail: (input.senderEmail as string | undefined) ?? null,
    });
  return rows.get(ref);
});
const processing = mock(
  async (receipt: InboxWebhookReceipt, reference: string) => {
    expect(rows.has(receipt.referenceId!)).toBe(true);
    if (rejectQueue) throw new Error("fixture queue unavailable");
    queued.set(reference, receipt.filePath!);
    return "queued" as const;
  },
);
const notify = mock(async () => ({ id: "fixture-notification" }));
mock.module("@midday/db/queries", () => ({
  getTeamByInboxId: async () => ({ id: teamId, email: null }),
  createInbox: register,
}));
mock.module("@midday/db/queries/inbox-receipts", () => ({
  getInboxReceiptByReferenceId: async (
    _db: unknown,
    input: { teamId: string; referenceId: string },
  ) => {
    const row = rows.get(input.referenceId);
    return row?.teamId === input.teamId ? row : undefined;
  },
}));
mock.module("../services/inbox-webhook-queue", () => ({
  enqueueInboxReceipt: processing,
}));
mock.module("@midday/job-client", () => ({ triggerJob: notify }));
mock.module("@api/services/supabase", () => ({
  createAdminClient: async () => ({
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("vault");
        return storage;
      },
    },
  }),
}));
mock.module("@api/services/resend", () => ({
  resend: {
    emails: {
      send: async () => {
        throw new Error("Unexpected outbound email");
      },
    },
  },
}));
mock.module("@midday/inbox", () => ({
  getInboxIdFromEmail,
  inboxWebhookPostSchema: createInboxWebhookPostSchema(),
}));
mock.module("@midday/documents", () => ({
  getAllowedAttachments: (items: WebhookAttachment[] | undefined) =>
    items?.filter((item) => item.ContentType === "application/pdf"),
}));
mock.module("@midday/email/config", () => ({
  isProductEmailSender: () => false,
  getProductEmailConfig: () => ({}),
  requireProductEmailReceipt: () => {},
}));
mock.module("@midday/logger", () => ({
  logger: { info() {}, warn() {}, error() {} },
}));
const { inboxWebhookRouter } = await import("../rest/routers/webhooks/inbox");
const app = new OpenAPIHono<Context>();
const db = {
  usePrimaryOnly() {
    return this;
  },
};
app.use("*", async (c, next) => {
  c.set("db", db as unknown as Context["Variables"]["db"]);
  c.set("clientIp", clientIp);
  await next();
});
app.route("/inbound", inboxWebhookRouter);

function item(content: string): WebhookAttachment {
  return {
    Name: "receipt.pdf",
    Content: Buffer.from(content).toString("base64"),
    ContentType: "application/pdf",
    ContentLength: Buffer.byteLength(content),
    ContentID: "",
  };
}
function request(attachments = [item("%PDF-one"), item("%PDF-two")]) {
  return app.request("/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      MessageID: "message-http-fixture",
      OriginalRecipient: "mailbox@inbox.example.test",
      FromFull: { Name: "Fixture sender", Email: "sender@vendor.test" },
      Subject: "Fixture invoice",
      Attachments: attachments,
    }),
  });
}
beforeEach(() => {
  objects.clear();
  rows.clear();
  queued.clear();
  refusedBytes.clear();
  options.length = 0;
  rejectQueue = false;
  lostStorageResponse = false;
  clientIp = "3.134.147.250";
  register.mockClear();
  processing.mockClear();
  notify.mockClear();
});
afterAll(() => {
  for (const [key, value] of prior) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("inbound webhook HTTP handoff", () => {
  test("partial failure returns retriable 503 and replay retains one copy per attachment", async () => {
    refusedBytes.add("%PDF-two");
    const partial = await request();
    expect(partial.status).toBe(503);
    expect(await partial.json()).toMatchObject({
      success: false,
      attempted: 2,
      accepted: 1,
      failed: 1,
    });
    expect([objects.size, rows.size, queued.size]).toEqual([1, 1, 1]);
    expect(notify).not.toHaveBeenCalled();
    refusedBytes.clear();
    expect((await request()).status).toBe(200);
    expect([objects.size, rows.size, queued.size]).toEqual([2, 2, 2]);
    expect(
      options.every((value) => (value as { upsert: boolean }).upsert === false),
    ).toBe(true);
  });
  test("all failed uploads never produce a success response", async () => {
    refusedBytes.add("%PDF-one");
    refusedBytes.add("%PDF-two");
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      accepted: 0,
      failed: 2,
    });
    expect(register).not.toHaveBeenCalled();
    expect(processing).not.toHaveBeenCalled();
  });
  test("queue outage retains Inbox registration before responding 503", async () => {
    rejectQueue = true;
    expect((await request()).status).toBe(503);
    expect([objects.size, rows.size, queued.size]).toEqual([2, 2, 0]);
    rejectQueue = false;
    expect((await request()).status).toBe(200);
    expect([objects.size, rows.size, queued.size]).toEqual([2, 2, 2]);
  });
  test("lost upload response is verified without an upsert", async () => {
    lostStorageResponse = true;
    expect((await request()).status).toBe(200);
    expect([objects.size, rows.size, queued.size]).toEqual([2, 2, 2]);
  });
  test("invalid attachment bytes fail before any side effect", async () => {
    const invalid = { ...item("%PDF-two"), ContentLength: 1 };
    expect((await request([item("%PDF-one"), invalid])).status).toBe(400);
    expect([objects.size, rows.size, queued.size]).toEqual([0, 0, 0]);
  });
  test("existing webhook IP authorization remains enforced", async () => {
    clientIp = "192.0.2.1";
    expect((await request()).status).toBe(403);
    expect(register).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });
});
