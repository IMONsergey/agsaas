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
const fixtureUsername = "postmark-fixture";
const fixturePassword = "synthetic-webhook-secret";
const fixtureAuthorization = `Basic ${Buffer.from(
  `${fixtureUsername}:${fixturePassword}`,
).toString("base64")}`;
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
process.env.INBOX_WEBHOOK_USERNAME = fixtureUsername;
process.env.INBOX_WEBHOOK_PASSWORD = fixturePassword;

const objects = new Map<string, Uint8Array>();
const rows = new Map<string, InboxWebhookReceipt>();
const erased = new Map<string, InboxWebhookReceipt>();
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
const findTeam = mock(async () => ({ id: teamId, email: null }));
const adminClient = mock(async () => ({
  storage: {
    from: (bucket: string) => {
      expect(bucket).toBe("vault");
      return storage;
    },
  },
}));
mock.module("@midday/db/queries", () => ({
  getTeamByInboxId: findTeam,
  createInbox: register,
}));
mock.module("@midday/db/queries/inbox-receipts", () => ({
  getInboxReceiptByReferenceId: async (
    _db: unknown,
    input: {
      teamId: string;
      referenceId: string;
      expectedProof?: { contentType: string; meta: Record<string, unknown> };
    },
  ) => {
    const row = rows.get(input.referenceId);
    if (row?.teamId === input.teamId) return row;
    const deleted = erased.get(input.referenceId);
    if (!deleted || deleted.teamId !== input.teamId) return undefined;
    const meta = deleted.meta as { contentSha256: string };
    return {
      ...deleted,
      filePath: null,
      fileName: null,
      meta: null,
      senderEmail: null,
      contentType: input.expectedProof?.contentType ?? null,
      status: "deleted",
      deletionProof: {
        contentSha256: meta.contentSha256,
        contentTypeMatches:
          input.expectedProof?.contentType === deleted.contentType,
        metadataRetained: true,
        metadataMatches:
          JSON.stringify(input.expectedProof?.meta) ===
          JSON.stringify(deleted.meta),
        unavailable: false,
      },
    };
  },
}));
mock.module("../services/inbox-webhook-queue", () => ({
  enqueueInboxReceipt: processing,
}));
mock.module("@midday/job-client", () => ({ triggerJob: notify }));
mock.module("@api/services/supabase", () => ({
  createAdminClient: adminClient,
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
  // Deliberately model an allowlisted IP, even when the caller supplied the
  // forwarded header. Basic authentication must hold independently of proxies.
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
function request(
  attachments = [item("%PDF-one"), item("%PDF-two")],
  {
    authorization = fixtureAuthorization,
    body,
  }: { authorization?: string | null; body?: string } = {},
) {
  return app.request("/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": "3.134.147.250, 192.0.2.1",
      ...(authorization === null ? {} : { Authorization: authorization }),
    },
    body:
      body ??
      JSON.stringify({
        MessageID: "message-http-fixture",
        OriginalRecipient: "mailbox@inbox.example.test",
        FromFull: { Name: "Fixture sender", Email: "sender@vendor.test" },
        Subject: "Fixture invoice",
        Attachments: attachments,
      }),
  });
}
beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.INBOX_WEBHOOK_USERNAME = fixtureUsername;
  process.env.INBOX_WEBHOOK_PASSWORD = fixturePassword;
  objects.clear();
  rows.clear();
  erased.clear();
  queued.clear();
  refusedBytes.clear();
  options.length = 0;
  rejectQueue = false;
  lostStorageResponse = false;
  clientIp = "3.134.147.250";
  register.mockClear();
  processing.mockClear();
  notify.mockClear();
  findTeam.mockClear();
  adminClient.mockClear();
});
afterAll(() => {
  for (const [key, value] of prior) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function expectNoIngestionSideEffects() {
  expect([objects.size, rows.size, queued.size]).toEqual([0, 0, 0]);
  expect(findTeam).not.toHaveBeenCalled();
  expect(adminClient).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  expect(processing).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
}

describe("inbound webhook authentication", () => {
  test("missing or partial configuration refuses a forged trusted IP before body or DB", async () => {
    const configurations = [
      [undefined, undefined],
      [fixtureUsername, undefined],
      [undefined, fixturePassword],
      ["", fixturePassword],
      [fixtureUsername, ""],
      ["   ", fixturePassword],
      [fixtureUsername, "   "],
    ] as const;
    for (const mode of ["production", "test", "development"]) {
      process.env.NODE_ENV = mode;
      for (const [username, password] of configurations) {
        if (username === undefined) delete process.env.INBOX_WEBHOOK_USERNAME;
        else process.env.INBOX_WEBHOOK_USERNAME = username;
        if (password === undefined) delete process.env.INBOX_WEBHOOK_PASSWORD;
        else process.env.INBOX_WEBHOOK_PASSWORD = password;
        const response = await request(undefined, { body: "not JSON" });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          success: false,
          error: "Inbox webhook is not configured",
        });
        expectNoIngestionSideEffects();
      }
    }
  });
  test("a forged trusted IP cannot bypass absent, malformed or incorrect Basic credentials", async () => {
    const invalid = [
      null,
      "Bearer synthetic-token",
      "Basic !!!",
      `Basic ${Buffer.from(`${fixtureUsername}:wrong`).toString("base64")}`,
      `Basic ${Buffer.from(`wrong:${fixturePassword}`).toString("base64")}`,
    ];
    for (const mode of ["production", "test", "development"]) {
      process.env.NODE_ENV = mode;
      for (const authorization of invalid) {
        const response = await request(undefined, {
          authorization,
          body: "not JSON",
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
        expectNoIngestionSideEffects();
      }
    }
  });
  test("fully configured Basic credentials permit the normal durable handoff", async () => {
    process.env.NODE_ENV = "production";
    expect((await request()).status).toBe(200);
    expect([objects.size, rows.size, queued.size]).toEqual([2, 2, 2]);
    expect(findTeam).toHaveBeenCalledTimes(1);
    expect(adminClient).toHaveBeenCalledTimes(1);
  });
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

test("HTTP replay of a physically erased receipt acknowledges exact evidence without notification or recreation", async () => {
  expect((await request([item("%PDF-one")])).status).toBe(200);
  for (const [ref, row] of rows) erased.set(ref, structuredClone(row));
  rows.clear();
  objects.clear();
  queued.clear();
  options.length = 0;
  register.mockClear();
  processing.mockClear();
  notify.mockClear();
  expect((await request([item("%PDF-one")])).status).toBe(200);
  expect((await request([item("%PDF-changed")])).status).toBe(503);
  expect([rows.size, objects.size, queued.size]).toEqual([0, 0, 0]);
  expect(register).not.toHaveBeenCalled();
  expect(processing).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(options).toEqual([]);
});
