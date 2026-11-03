import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { apiKeysRouter } from "../../trpc/routers/api-keys";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const createCaller = createCallerFactory(apiKeysRouter);

const KEY_ID = "f1e2d3c4-b5a6-7890-abcd-ef1234567890";

beforeEach(() => {
  mocks.getTeamMemberRole.mockReset();
  mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("owner"));
});

describe("tRPC: apiKeys.get", () => {
  beforeEach(() => {
    mocks.getApiKeysByTeam.mockReset();
    mocks.getApiKeysByTeam.mockImplementation(() => Promise.resolve([]));
  });

  test("returns keys for team", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.get();

    expect(result).toEqual([]);
    expect(mocks.getApiKeysByTeam).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });

  test("rejects without session", async () => {
    const ctx = createTestContext();
    const caller = createCaller({ ...ctx, session: null });

    await expect(caller.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("tRPC: apiKeys.upsert", () => {
  beforeEach(() => {
    mocks.upsertApiKey.mockReset();
    mocks.resendEmailsSend.mockReset();
    mocks.upsertApiKey.mockImplementation(() =>
      Promise.resolve({
        key: "md_test_key_plaintext",
        data: {
          id: KEY_ID,
          name: "Test Key",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    mocks.resendEmailsSend.mockImplementation(() => Promise.resolve());
  });

  test("creates key and returns plaintext key plus row data", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.upsert({
      name: "Test Key",
      scopes: ["apis.read"],
    });

    expect(result).toEqual({
      key: "md_test_key_plaintext",
      data: {
        id: KEY_ID,
        name: "Test Key",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(mocks.upsertApiKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "test-team-id",
        userId: "test-user-id",
        name: "Test Key",
        scopes: ["apis.read"],
      }),
    );
  });
});

describe("tRPC: apiKeys.delete", () => {
  beforeEach(() => {
    mocks.deleteApiKey.mockReset();
    mocks.deleteApiKey.mockImplementation(() =>
      Promise.resolve("key-hash-for-cache"),
    );
  });

  test("deletes the current owner's key without returning its private cache hash", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.delete({ id: KEY_ID });

    expect(result).toEqual({ id: KEY_ID, deleted: true });
    expect(JSON.stringify(result)).not.toContain("key-hash-for-cache");
    expect(mocks.deleteApiKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: KEY_ID,
        teamId: "test-team-id",
        actorUserId: "test-user-id",
      }),
    );
  });

  test("a missing key is not reported as deleted", async () => {
    mocks.deleteApiKey.mockImplementationOnce(() => Promise.resolve(undefined));
    expect(
      await createCaller(createTestContext()).delete({ id: KEY_ID }),
    ).toEqual({ id: KEY_ID, deleted: false });
  });
});

describe("tRPC: apiKeys owner authorization", () => {
  beforeEach(() => {
    mocks.getApiKeysByTeam.mockReset();
    mocks.upsertApiKey.mockReset();
    mocks.deleteApiKey.mockReset();
    mocks.resendEmailsSend.mockReset();
  });

  for (const role of ["member", null]) {
    test(`rejects ${role ?? "missing"} role before key access or email`, async () => {
      mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve(role));
      const caller = createCaller(createTestContext());

      await expect(caller.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller.upsert({ name: "Test Key", scopes: ["apis.read"] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.delete({ id: KEY_ID })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      expect(mocks.getTeamMemberRole).toHaveBeenCalledTimes(3);
      expect(mocks.getApiKeysByTeam).not.toHaveBeenCalled();
      expect(mocks.upsertApiKey).not.toHaveBeenCalled();
      expect(mocks.deleteApiKey).not.toHaveBeenCalled();
      expect(mocks.resendEmailsSend).not.toHaveBeenCalled();
    });
  }
});
