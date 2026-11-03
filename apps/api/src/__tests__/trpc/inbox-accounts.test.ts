import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { inboxAccountsRouter } from "../../trpc/routers/inbox-accounts";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const ACCOUNT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const CLEANUP_ID = "e49673b0-5a46-40ad-ab64-faf040dd62cd";
const deletedAccount = {
  id: ACCOUNT_ID,
  scheduleId: null,
  cleanupPending: true,
  cleanupId: CLEANUP_ID,
};

const createCaller = createCallerFactory(inboxAccountsRouter);

describe("tRPC: inbox connection bypasses are closed", () => {
  test("requires the browser handshake instead of issuing an unbound state", async () => {
    const caller = createCaller(createTestContext());
    await expect(caller.connect({ provider: "gmail" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
  test("does not exchange a bare provider authorization code", async () => {
    const caller = createCaller(createTestContext());
    await expect(
      caller.exchangeCodeForAccount({
        provider: "outlook",
        code: "unbound-code",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("tRPC: inboxAccounts.get", () => {
  beforeEach(() => {
    mocks.getInboxAccounts.mockReset();
    mocks.getInboxAccounts.mockImplementation(() => Promise.resolve([]));
  });

  test("returns inbox accounts for the team", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.get();

    expect(result).toEqual([]);
    expect(mocks.getInboxAccounts).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });

  test("propagates when getInboxAccounts fails", async () => {
    mocks.getInboxAccounts.mockImplementation(() =>
      Promise.reject(new Error("database unavailable")),
    );

    const caller = createCaller(createTestContext());

    await expect(caller.get()).rejects.toThrow("database unavailable");
  });
});

describe("tRPC: inboxAccounts.delete", () => {
  beforeEach(() => {
    mocks.deleteInboxAccount.mockReset();
    mocks.removeInboxSyncScheduler.mockReset();
    mocks.removeInboxSyncScheduler.mockImplementation(() =>
      Promise.resolve(true),
    );
    mocks.deleteInboxAccount.mockImplementation(() =>
      Promise.resolve(deletedAccount),
    );
  });

  test("returns the local deletion and retained provider cleanup separately", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.delete({ id: ACCOUNT_ID });

    expect(result).toEqual({
      id: ACCOUNT_ID,
      scheduleId: null,
      cleanupPending: true,
      cleanupId: CLEANUP_ID,
      schedulerCleanupPending: false,
    });
    expect(mocks.deleteInboxAccount).toHaveBeenCalledWith(expect.anything(), {
      id: ACCOUNT_ID,
      teamId: "test-team-id",
      actorUserId: "test-user-id",
    });
    expect(mocks.removeInboxSyncScheduler).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  test("returns no receipt when nothing was deleted", async () => {
    mocks.deleteInboxAccount.mockImplementation(() =>
      Promise.resolve(undefined),
    );

    const caller = createCaller(createTestContext());
    expect(await caller.delete({ id: ACCOUNT_ID })).toBeUndefined();
    expect(mocks.removeInboxSyncScheduler).not.toHaveBeenCalled();
  });
  test("legacy cloud schedule IDs never choose which own scheduler to delete", async () => {
    mocks.deleteInboxAccount.mockImplementation(() =>
      Promise.resolve({
        ...deletedAccount,
        scheduleId: "legacy-cloud-schedule",
      }),
    );
    await createCaller(createTestContext()).delete({ id: ACCOUNT_ID });
    expect(mocks.removeInboxSyncScheduler).toHaveBeenCalledWith(ACCOUNT_ID);
  });
  test("a Redis outage does not misreport a committed credential deletion as failed", async () => {
    mocks.removeInboxSyncScheduler.mockImplementation(() =>
      Promise.reject(new Error("Redis unavailable")),
    );
    expect(
      await createCaller(createTestContext()).delete({ id: ACCOUNT_ID }),
    ).toMatchObject({
      id: ACCOUNT_ID,
      schedulerCleanupPending: true,
      cleanupPending: true,
      cleanupId: CLEANUP_ID,
    });
    expect(mocks.deleteInboxAccount).toHaveBeenCalledTimes(1);
  });
  test("cleanup retention failure never reaches the scheduler", async () => {
    mocks.deleteInboxAccount.mockImplementationOnce(() =>
      Promise.reject(new Error("Cleanup retention failed")),
    );
    await expect(
      createCaller(createTestContext()).delete({ id: ACCOUNT_ID }),
    ).rejects.toThrow("Cleanup retention failed");
    expect(mocks.removeInboxSyncScheduler).not.toHaveBeenCalled();
  });
});

describe("tRPC: inbox manual sync uses own tenant-scoped queue", () => {
  const keys = [
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REDIRECT_URI",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    for (const key of keys) process.env[key] = "fixture-configured";
    mocks.getInboxAccountById.mockReset();
    mocks.getInboxAccountById.mockImplementation(() =>
      Promise.resolve({ id: ACCOUNT_ID, provider: "gmail" }),
    );
    mocks.triggerJob.mockReset();
    mocks.triggerJob.mockImplementation(() =>
      Promise.resolve({ id: "inbox-provider:123" }),
    );
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  test("returns an own job ID without a cloud access token and binds its team", async () => {
    const result = await createCaller(createTestContext()).sync({
      id: ACCOUNT_ID,
      manualSync: true,
    });
    expect(result).toEqual({ id: "inbox-provider:123" });
    expect(mocks.getInboxAccountById).toHaveBeenCalledWith(expect.anything(), {
      id: ACCOUNT_ID,
      teamId: "test-team-id",
    });
    expect(mocks.triggerJob).toHaveBeenCalledWith(
      "sync-scheduler",
      { id: ACCOUNT_ID, teamId: "test-team-id", manualSync: true },
      "inbox-provider",
    );
  });
  test("a foreign or missing account never reaches a queue", async () => {
    mocks.getInboxAccountById.mockImplementation(() => Promise.resolve(null));
    await expect(
      createCaller(createTestContext()).sync({ id: ACCOUNT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
  test("unconfigured provider fails before enqueue", async () => {
    delete process.env.GMAIL_CLIENT_SECRET;
    await expect(
      createCaller(createTestContext()).sync({ id: ACCOUNT_ID }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
  test("enqueue rejection is never reported as queued", async () => {
    mocks.triggerJob.mockImplementation(() =>
      Promise.reject(new Error("queue unavailable")),
    );
    await expect(
      createCaller(createTestContext()).sync({ id: ACCOUNT_ID }),
    ).rejects.toThrow("queue unavailable");
  });
});
