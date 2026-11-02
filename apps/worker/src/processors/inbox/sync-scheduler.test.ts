import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import type { Job } from "bullmq";
import type {
  InboxProviderInitialSetupPayload,
  InboxProviderSyncAccountPayload,
} from "../../schemas/inbox";

// Real processors and schemas, substituted local DB/provider/storage transports.
// Run separately from other worker suites so mocks cannot leak into invoice jobs.
const savedFetch = globalThis.fetch;
const savedConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error("Live network forbidden in inbox provider tests");
};
globalThis.fetch = Object.assign(async () => forbidden(), {
  preconnect: forbidden,
});
Socket.prototype.connect = forbidden;
const accountId = "00000000-0000-4000-8000-000000000001";
const teamId = "00000000-0000-4000-8000-000000000002";
const foreignTeamId = "00000000-0000-4000-8000-000000000003";
const db = {};
let account: any;
const reads: any[] = [];
let attachments: any[] = [];
let uploadFails = false;
let queueFails = false;
let providerCalls = 0;
let connectorConstructions = 0;
const uploads: Array<{ key: string; options: unknown }> = [];
const enqueues: Array<{ name: string; payload: any; queue: string }> = [];
const updates: any[] = [];
const registered: any[] = [];
const removed: any[] = [];
mock.module("../../utils/db", () => ({ getDb: () => db }));
mock.module("../../schedulers/registry", () => ({
  registerDynamicScheduler: async (input: unknown) => {
    registered.push(input);
  },
  unregisterDynamicScheduler: async (...input: unknown[]) => {
    removed.push(input);
  },
}));
mock.module("@midday/db/queries", () => ({
  getInboxAccountInfo: async () => (reads.length ? reads.shift() : account),
  getExistingInboxAttachmentsByReferenceIds: async () => [],
  getInboxBlocklist: async () => [],
  updateInboxAccount: async (_db: unknown, input: unknown) => {
    updates.push(input);
    return {};
  },
}));
mock.module("@midday/inbox/connector", () => ({
  InboxConnector: class {
    constructor() {
      connectorConstructions++;
    }
    async getAttachments() {
      providerCalls++;
      return attachments;
    }
  },
}));
mock.module("@midday/job-client", () => ({
  triggerJob: async (name: string, payload: unknown, queue: string) => {
    enqueues.push({ name, payload, queue });
    if (queueFails) throw new Error("Fixture queue unavailable");
    return { id: `${queue}:${enqueues.length}` };
  },
}));
mock.module("@midday/supabase/job", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: async (key: string, _data: unknown, options: unknown) => {
          uploads.push({ key, options });
          return uploadFails
            ? { data: null, error: new Error("Fixture storage unavailable") }
            : { data: { path: key }, error: null };
        },
      }),
    },
  }),
}));
const { SyncSchedulerProcessor } = await import("./sync-scheduler");
const { InitialSetupProcessor } = await import("./initial-setup");
const syncJob = (patch: Partial<InboxProviderSyncAccountPayload> = {}) =>
  ({
    id: "fixture-sync",
    data: { id: accountId, teamId, manualSync: true, ...patch },
  }) as Job<InboxProviderSyncAccountPayload>;
const setupJob = (patch: Partial<InboxProviderInitialSetupPayload> = {}) =>
  ({
    id: "fixture-setup",
    data: { inboxAccountId: accountId, teamId, ...patch },
  }) as Job<InboxProviderInitialSetupPayload>;
const attachment = (referenceId: string) => ({
  referenceId,
  filename: "../../invoice.pdf",
  mimeType: "application/pdf",
  size: 4,
  data: Buffer.from("fake"),
});
beforeEach(() => {
  account = {
    id: accountId,
    teamId,
    provider: "gmail",
    status: "connected",
    lastAccessed: "2026-01-01T00:00:00.000Z",
  };
  reads.length = 0;
  attachments = [attachment("ref-1")];
  uploadFails = false;
  queueFails = false;
  providerCalls = 0;
  connectorConstructions = 0;
  uploads.length = 0;
  enqueues.length = 0;
  updates.length = 0;
  registered.length = 0;
  removed.length = 0;
});
afterAll(() => {
  globalThis.fetch = savedFetch;
  Socket.prototype.connect = savedConnect;
});

describe("own inbox lifecycle", () => {
  test("a missing account removes its persisted scheduler without provider or storage work", async () => {
    account = null;
    await expect(
      new SyncSchedulerProcessor().process(syncJob()),
    ).rejects.toThrow("removed");
    expect(removed).toEqual([["inbox-sync-scheduler", accountId]]);
    expect(connectorConstructions).toBe(0);
    expect(uploads).toHaveLength(0);
    expect(enqueues).toHaveLength(0);
  });
  test("foreign tenant payload fails before touching another account or its schedule", async () => {
    await expect(
      new SyncSchedulerProcessor().process(syncJob({ teamId: foreignTeamId })),
    ).rejects.toThrow("scope mismatch");
    expect(connectorConstructions).toBe(0);
    expect(removed).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
  test("a disconnected account stops requests until OAuth reconnect configures it again", async () => {
    account.status = "disconnected";
    await expect(
      new SyncSchedulerProcessor().process(syncJob()),
    ).rejects.toThrow("reconnection");
    expect(connectorConstructions).toBe(0);
    expect(removed).toHaveLength(1);
  });
  test("deletion during provider fetch prevents storage, child jobs and successful checkpoint", async () => {
    reads.push(account, null);
    await expect(
      new SyncSchedulerProcessor().process(syncJob()),
    ).rejects.toThrow("changed during sync");
    expect(providerCalls).toBe(1);
    expect(uploads).toHaveLength(0);
    expect(enqueues).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
  test("upload rejection cannot advance the inbox cursor or claim success", async () => {
    uploadFails = true;
    await expect(
      new SyncSchedulerProcessor().process(syncJob()),
    ).rejects.toThrow("upload failed");
    expect(uploads).toHaveLength(1);
    expect(enqueues).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
  test("follow-up queue rejection leaves the cursor available for safe provider rescan", async () => {
    queueFails = true;
    await expect(
      new SyncSchedulerProcessor().process(syncJob()),
    ).rejects.toThrow("queue unavailable");
    expect(enqueues[0]?.name).toBe("process-attachment");
    expect(updates).toHaveLength(0);
  });
  test("equal names get distinct safe objects and completion describes queued attachments", async () => {
    attachments = [attachment("ref-1"), attachment("ref-2")];
    const result = await new SyncSchedulerProcessor().process(syncJob());
    expect(result).toMatchObject({ accountId, attachmentsProcessed: 2 });
    expect(new Set(uploads.map((item) => item.key)).size).toBe(2);
    for (const item of uploads) {
      expect(item.key.startsWith(`${teamId}/inbox/${accountId}/`)).toBe(true);
      expect(item.key.split("/")).toHaveLength(5);
    }
    expect(
      enqueues.filter((item) => item.name === "process-attachment"),
    ).toHaveLength(2);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: accountId,
      status: "connected",
      errorMessage: null,
    });
  });
  test("initial setup rechecks live ownership and creates a tenant-visible own sync job", async () => {
    const result = await new InitialSetupProcessor().process(setupJob());
    expect(result).toMatchObject({
      schedulerRegistered: true,
      syncJobId: "inbox-provider:1",
    });
    expect(registered[0]).toMatchObject({
      template: "inbox-sync-scheduler",
      accountId,
    });
    expect(enqueues[0]).toEqual({
      name: "sync-scheduler",
      payload: { id: accountId, teamId, manualSync: true },
      queue: "inbox-provider",
    });
  });
  test("a stale setup job cannot resurrect a deleted account's scheduler", async () => {
    reads.push(account, null);
    expect(await new InitialSetupProcessor().process(setupJob())).toMatchObject(
      { schedulerRegistered: false },
    );
    expect(registered).toHaveLength(1);
    expect(removed).toEqual([["inbox-sync-scheduler", accountId]]);
    expect(enqueues).toHaveLength(0);
  });
  test("initial setup rejects a forged team before scheduler registration", async () => {
    await expect(
      new InitialSetupProcessor().process(setupJob({ teamId: foreignTeamId })),
    ).rejects.toThrow("scope mismatch");
    expect(registered).toHaveLength(0);
    expect(enqueues).toHaveLength(0);
  });
});
