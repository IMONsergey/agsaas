import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Session } from "@api/utils/auth";
import type { Database } from "@midday/db/client";

const cachedPermission = mock(async (_key: string): Promise<boolean> => true);
const cacheWrite = mock(async (_key: string, _value: boolean) => {});
mock.module("@midday/cache/team-cache", () => ({
  teamCache: { get: cachedPermission, set: cacheWrite },
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({ warn() {}, info() {} }),
}));

const { withTeamPermission } = await import(
  "../../trpc/middleware/team-permission"
);

const userId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const otherTeamId = "33333333-3333-4333-8333-333333333333";
const session: Session = { user: { id: userId } };

type UserMemberships = {
  teamId: string | null;
  usersOnTeams: { id: string; teamId: string }[];
};

function memberOf(activeTeamId: string | null = teamId): UserMemberships {
  return {
    teamId: activeTeamId,
    usersOnTeams: activeTeamId
      ? [{ id: "membership-1", teamId: activeTeamId }]
      : [],
  };
}

function createDatabases(result: UserMemberships | undefined = memberOf()) {
  const primaryFind = mock(
    async (): Promise<UserMemberships | undefined> => result,
  );
  const replicaFind = mock(async () => memberOf());
  const primary = {
    query: { users: { findFirst: primaryFind } },
  } as unknown as Database;
  const replica = {
    query: { users: { findFirst: replicaFind } },
    usePrimaryOnly: () => primary,
  } as unknown as Database;

  return { primary, replica, primaryFind, replicaFind };
}

beforeEach(() => {
  cachedPermission.mockClear();
  cachedPermission.mockResolvedValue(true);
  cacheWrite.mockClear();
});

describe("tRPC membership authorization", () => {
  it("rejects a cached allow when the primary has revoked membership", async () => {
    const { replica, primaryFind, replicaFind } = createDatabases({
      teamId,
      usersOnTeams: [],
    });
    const next = mock(async () => "protected data");

    await expect(
      withTeamPermission({ ctx: { session, db: replica }, next }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(primaryFind).toHaveBeenCalledTimes(1);
    expect(replicaFind).not.toHaveBeenCalled();
    expect(cachedPermission).not.toHaveBeenCalled();
    expect(cacheWrite).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("does not let a cached deny override a newly granted membership", async () => {
    cachedPermission.mockResolvedValue(false);
    const { replica } = createDatabases();
    const result = await withTeamPermission({
      ctx: { session, db: replica },
      next: async ({ ctx }) => ctx.teamId,
    });

    expect(result).toBe(teamId);
    expect(cachedPermission).not.toHaveBeenCalled();
  });

  it("requires membership in the active team, not just any team", async () => {
    const { replica } = createDatabases({
      teamId,
      usersOnTeams: [{ id: "other-membership", teamId: otherTeamId }],
    });

    await expect(
      withTeamPermission({
        ctx: { session, db: replica },
        next: async () => "protected data",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("preserves the downstream database and session for an authorized request", async () => {
    const { replica, primaryFind, replicaFind } = createDatabases();
    const result = await withTeamPermission({
      ctx: { session, db: replica },
      next: async ({ ctx }) => ctx,
    });

    expect(Object.is(result.db, replica)).toBe(true);
    expect(Object.is(result.session, session)).toBe(true);
    expect(result.teamId).toBe(teamId);
    expect(primaryFind).toHaveBeenCalledTimes(1);
    expect(replicaFind).not.toHaveBeenCalled();
  });

  it("keeps onboarding available before a user selects a team", async () => {
    const { replica } = createDatabases(memberOf(null));
    const result = await withTeamPermission({
      ctx: { session, db: replica },
      next: async ({ ctx }) => ctx.teamId,
    });

    expect(result).toBeNull();
    expect(cachedPermission).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent permission reads within the same request", async () => {
    const { replica, primaryFind } = createDatabases();
    const ctx = { session, db: replica };
    const next = mock(async () => "ok");

    expect(
      await Promise.all([
        withTeamPermission({ ctx, next }),
        withTeamPermission({ ctx, next }),
      ]),
    ).toEqual(["ok", "ok"]);
    expect(primaryFind).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("rechecks a later request after a successful earlier request", async () => {
    const { replica, primaryFind } = createDatabases();
    await withTeamPermission({
      ctx: { session, db: replica },
      next: async () => "ok",
    });
    primaryFind.mockResolvedValue({ teamId, usersOnTeams: [] });

    await expect(
      withTeamPermission({
        ctx: { session, db: replica },
        next: async () => "protected data",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(primaryFind).toHaveBeenCalledTimes(2);
  });

  it("uses a primary-only database even without a replica-routing helper", async () => {
    const { primary, primaryFind } = createDatabases();
    await withTeamPermission({
      ctx: { session, db: primary },
      next: async () => "ok",
    });

    expect(primaryFind).toHaveBeenCalledTimes(1);
  });

  it("rejects a deleted user even when the replica still has the old user", async () => {
    const { replica, primaryFind, replicaFind } = createDatabases();
    primaryFind.mockResolvedValue(undefined);

    await expect(
      withTeamPermission({
        ctx: { session, db: replica },
        next: async () => "protected data",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(replicaFind).not.toHaveBeenCalled();
  });

  it("rejects an absent session without reading the database", async () => {
    const { replica, primaryFind, replicaFind } = createDatabases();

    await expect(
      withTeamPermission({
        ctx: { session: null, db: replica },
        next: async () => "protected data",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(primaryFind).not.toHaveBeenCalled();
    expect(replicaFind).not.toHaveBeenCalled();
  });

  it("fails closed if the authoritative membership lookup fails", async () => {
    const { replica, primaryFind } = createDatabases();
    const failure = new Error("membership storage unavailable");
    primaryFind.mockRejectedValue(failure);
    const next = mock(async () => "protected data");

    await expect(
      withTeamPermission({ ctx: { session, db: replica }, next }),
    ).rejects.toBe(failure);
    expect(next).not.toHaveBeenCalled();
    expect(cachedPermission).not.toHaveBeenCalled();
  });
});
