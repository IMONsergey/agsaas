import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TeamMembershipError } from "@midday/db/errors";
import { getUserInvites } from "@midday/db/queries";
import { FILE_KEY_TTL_SECONDS, verifyFileKey } from "@midday/encryption";
import { createCallerFactory } from "../../trpc/init";
import { userRouter } from "../../trpc/routers/user";
import { createTestContext } from "../helpers/test-context";
import { asMock, mocks } from "../setup";

if (!process.env.FILE_KEY_SECRET) {
  process.env.FILE_KEY_SECRET = "test-file-key-secret-for-trpc-user-tests";
}

const createCaller = createCallerFactory(userRouter);

describe("tRPC: user.me", () => {
  const userId = "39da844a-f0a9-46e6-b036-1d79f80b75f6";
  const teamId = "3fa9de6c-cf07-49ed-ab27-41f2bd44a0fa";
  const sessionId = "2726380b-c732-4898-a2fe-2325623b1203";

  function createCurrentUserContext() {
    const ctx = createTestContext({ userId, teamId });
    const db = {
      ...ctx.db,
      query: {
        ...ctx.db.query,
        users: {
          findFirst: async () => ({
            id: userId,
            teamId,
            usersOnTeams: [{ id: "current-user-membership", teamId }],
          }),
        },
      },
    };
    db.usePrimaryOnly = () => db;
    return {
      ...ctx,
      db,
      session: { ...ctx.session, sessionId, aal: "aal2" as const },
    };
  }

  beforeEach(() => {
    mocks.getUserById.mockReset();
    mocks.getUserById.mockImplementation(() =>
      Promise.resolve({
        id: userId,
        email: "test@example.com",
        fullName: "Test User",
        teamId,
        avatarUrl: null,
        locale: null,
        timeFormat: null,
        dateFormat: null,
        weekStartsOnMonday: null,
        timezone: null,
        timezoneAutoSync: null,
        team: null,
      }),
    );
  });

  test("returns a bounded file key tied to the current session, user, team, and assurance", async () => {
    const caller = createCaller(createCurrentUserContext());
    const startedAt = Date.now();
    const result = await caller.me();

    expect(result).toMatchObject({
      id: userId,
      email: "test@example.com",
      fullName: "Test User",
      teamId,
    });
    if (!result?.fileKey)
      throw new Error("Expected a current-session file key");
    expect(await verifyFileKey(result.fileKey)).toEqual({
      userId,
      teamId,
      sessionId,
      aal: "aal2",
    });
    if (typeof result.fileKeyExpiresAt !== "number")
      throw new Error("Expected a bounded file key deadline");
    expect(result.fileKeyExpiresAt).toBeGreaterThan(startedAt);
    expect(result.fileKeyExpiresAt).toBeLessThanOrEqual(
      Date.now() + FILE_KEY_TTL_SECONDS * 1000,
    );
  });

  test("loads the profile by the authenticated user id", async () => {
    const caller = createCaller(createCurrentUserContext());
    await caller.me();

    expect(mocks.getUserById).toHaveBeenCalledWith(expect.anything(), userId);
  });

  test("does not issue a file key without a current Auth session id", async () => {
    const ctx = createCurrentUserContext();
    const result = await createCaller({
      ...ctx,
      session: { ...ctx.session, sessionId: undefined },
    }).me();
    expect(result).toMatchObject({
      id: userId,
      fileKey: null,
      fileKeyExpiresAt: null,
    });
  });

  test("returns undefined when user is not found", async () => {
    mocks.getUserById.mockImplementation(() => Promise.resolve(null));

    const caller = createCaller(createCurrentUserContext());
    const result = await caller.me();

    expect(result).toBeUndefined();
  });
});

describe("tRPC: user.update", () => {
  beforeEach(() => {
    mocks.updateUser.mockReset();
    mocks.updateUser.mockImplementation(() =>
      Promise.resolve({
        id: "test-user-id",
        fullName: "New Name",
      }),
    );
  });

  test("updates full name", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.update({ fullName: "New Name" });

    expect(result).toMatchObject({
      id: "test-user-id",
      fullName: "New Name",
    });
  });

  test("passes session user id to DB query", async () => {
    const caller = createCaller(createTestContext());
    await caller.update({ fullName: "New Name" });

    expect(mocks.updateUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "test-user-id",
        fullName: "New Name",
      }),
    );
  });

  test("rejects full name shorter than minimum length", async () => {
    const caller = createCaller(createTestContext());

    await expect(caller.update({ fullName: "N" })).rejects.toThrow();
  });
});

describe("tRPC: user.invites", () => {
  beforeEach(() => {
    asMock(getUserInvites).mockReset();
    asMock(getUserInvites).mockImplementation(() => Promise.resolve([]));
  });

  test("returns invite list", async () => {
    asMock(getUserInvites).mockImplementation(() =>
      Promise.resolve([
        {
          id: "invite-1",
          email: "invitee@example.com",
          status: "pending",
        },
      ]),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.invites();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "invite-1" });
  });

  test("queries invites with session email", async () => {
    asMock(getUserInvites).mockImplementation(() => Promise.resolve([]));

    const caller = createCaller(createTestContext());
    await caller.invites();

    expect(getUserInvites).toHaveBeenCalledWith(
      expect.anything(),
      "test@example.com",
    );
  });

  test("returns empty list when session email is missing", async () => {
    const base = createTestContext();
    const caller = createCaller({
      ...base,
      session: {
        user: {
          id: "test-user-id",
        },
      },
    });

    const result = await caller.invites();

    expect(result).toEqual([]);
    expect(getUserInvites).not.toHaveBeenCalled();
  });
});

const SWITCH_TEAM_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("tRPC: user.switchTeam", () => {
  beforeEach(() => {
    mocks.switchUserTeam.mockReset();
    mocks.switchUserTeam.mockImplementation(() =>
      Promise.resolve({
        id: "test-user-id",
        teamId: SWITCH_TEAM_ID,
        previousTeamId: "test-team-id",
      }),
    );
  });

  test("switches active team and calls switchUserTeam", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.switchTeam({ teamId: SWITCH_TEAM_ID });

    expect(result).toMatchObject({
      teamId: SWITCH_TEAM_ID,
      previousTeamId: "test-team-id",
    });
    expect(mocks.switchUserTeam).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "test-user-id",
        teamId: SWITCH_TEAM_ID,
      }),
    );
  });
});

describe("tRPC: user.delete", () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalAudience = process.env.RESEND_AUDIENCE_ID;
  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
    if (originalAudience === undefined) delete process.env.RESEND_AUDIENCE_ID;
    else process.env.RESEND_AUDIENCE_ID = originalAudience;
  });
  beforeEach(() => {
    mocks.deleteUser.mockReset();
    mocks.deleteUser.mockImplementation(async (_db, id, deleteAuth) => {
      await deleteAuth();
      return { id, cleanupPending: true };
    });
    mocks.supabaseAdminDeleteUser.mockReset();
    mocks.supabaseAdminDeleteUser.mockImplementation(() =>
      Promise.resolve({ data: {}, error: null }),
    );
    mocks.resendContactsRemove.mockReset();
    mocks.resendContactsRemove.mockImplementation(() =>
      Promise.resolve({ data: {}, error: null }),
    );
  });

  test("deletes user and calls deleteUser", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.delete();

    expect(result).toEqual({ id: "test-user-id", cleanupPending: true });
    expect(mocks.deleteUser).toHaveBeenCalledWith(
      expect.anything(),
      "test-user-id",
      expect.any(Function),
    );
    expect(mocks.supabaseAdminDeleteUser).toHaveBeenCalledWith("test-user-id");
    expect(mocks.resendContactsRemove).not.toHaveBeenCalled();
  });

  test("a shared-team last-owner rejection happens before Auth or marketing", async () => {
    mocks.deleteUser.mockImplementation(async () => {
      throw new TeamMembershipError("LAST_TEAM_OWNER");
    });
    await expect(
      createCaller(createTestContext()).delete(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.supabaseAdminDeleteUser).not.toHaveBeenCalled();
    expect(mocks.resendContactsRemove).not.toHaveBeenCalled();
  });

  test("checks a returned Auth error and does not run marketing cleanup", async () => {
    mocks.supabaseAdminDeleteUser.mockImplementation(async () => ({
      data: null,
      error: { code: "unexpected_failure" },
    }));
    await expect(createCaller(createTestContext()).delete()).rejects.toThrow(
      "could not be confirmed",
    );
    expect(mocks.resendContactsRemove).not.toHaveBeenCalled();
  });

  test("an Auth transport rejection is not reported as successful deletion", async () => {
    mocks.supabaseAdminDeleteUser.mockImplementation(async () => {
      throw new Error("timeout");
    });
    await expect(createCaller(createTestContext()).delete()).rejects.toThrow(
      "could not be confirmed",
    );
    expect(mocks.resendContactsRemove).not.toHaveBeenCalled();
  });

  test("a previously removed Auth user can complete idempotent local cleanup", async () => {
    mocks.supabaseAdminDeleteUser.mockImplementation(async () => ({
      data: null,
      error: { code: "user_not_found" },
    }));
    expect(await createCaller(createTestContext()).delete()).toEqual({
      id: "test-user-id",
      cleanupPending: true,
    });
  });

  for (const setting of ["RESEND_API_KEY", "RESEND_AUDIENCE_ID"] as const) {
    test(`account deletion works without optional ${setting}`, async () => {
      delete process.env[setting];
      expect(await createCaller(createTestContext()).delete()).toEqual({
        id: "test-user-id",
        cleanupPending: true,
      });
      expect(mocks.resendContactsRemove).not.toHaveBeenCalled();
    });
  }

  test("marketing returned errors are deferred to the retained cleanup worker", async () => {
    mocks.resendContactsRemove.mockImplementation(async () => ({
      data: null,
      error: { message: "unavailable" },
    }));
    expect(await createCaller(createTestContext()).delete()).toEqual({
      id: "test-user-id",
      cleanupPending: true,
    });
    expect(mocks.resendContactsRemove).not.toHaveBeenCalled();
  });

  test("marketing exceptions are never invoked by the deletion request", async () => {
    mocks.resendContactsRemove.mockImplementation(async () => {
      throw new Error("unavailable");
    });
    expect(await createCaller(createTestContext()).delete()).toEqual({
      id: "test-user-id",
      cleanupPending: true,
    });
    expect(mocks.resendContactsRemove).not.toHaveBeenCalled();
  });
});
