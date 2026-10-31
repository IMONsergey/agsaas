import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Session } from "@api/utils/auth";
import type { Database } from "@midday/db/client";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SignJWT } from "jose";
import {
  actorEmail,
  actorId,
  inviteeEmail,
  signAccessToken,
  verifyAccessToken,
} from "./jwt-fixture";

const inviteId = "44444444-4444-4444-8444-444444444444";
const invitedTeamId = "22222222-2222-4222-8222-222222222222";
const invite = {
  id: inviteId,
  email: inviteeEmail,
  role: "owner" as const,
  teamId: invitedTeamId,
};
const listedInvite = {
  id: inviteId,
  email: inviteeEmail,
  role: "owner" as const,
  code: "local-invite-code",
  user: null,
  team: null,
};
const dialect = new PgDialect();
const findInvites = mock(async ({ where }: { where: SQL }) =>
  dialect.sqlToQuery(where).params[0] === inviteeEmail ? [listedInvite] : [],
);
const findInvite = mock(async ({ where }: { where: SQL }) =>
  dialect.sqlToQuery(where).params[0] === inviteId ? invite : undefined,
);
const insertMembership = mock(async (_values: unknown) => {});
const deleteInvite = mock(async (_where: SQL) => {});
const db = {
  query: {
    users: {
      findFirst: async () => ({
        id: actorId,
        // A profile email is editable too; it is not an invitation credential.
        email: inviteeEmail,
        teamId: null,
        usersOnTeams: [],
      }),
    },
    userInvites: { findMany: findInvites, findFirst: findInvite },
  },
  insert: () => ({ values: insertMembership }),
  delete: () => ({ where: deleteInvite }),
} as unknown as Database;

// Keep the real invitation SQL builders and email comparison, but no database
// connection. The actual routers and protected middleware are exercised below.
const invitationQueries = await import("@db/queries/user-invites");
const unexpectedOperation = () => {
  throw new Error("Unexpected operation outside the auth regression fixture");
};
mock.module("@midday/db/client", () => ({ db }));
mock.module("@midday/db/queries", () => ({
  ...invitationQueries,
  createTeam: unexpectedOperation,
  deleteTeam: unexpectedOperation,
  deleteTeamMember: unexpectedOperation,
  deleteUser: unexpectedOperation,
  getAvailablePlans: unexpectedOperation,
  getBankConnections: unexpectedOperation,
  getInboxAccounts: unexpectedOperation,
  getTeamById: unexpectedOperation,
  getTeamMemberRole: unexpectedOperation,
  getTeamMembersByTeamId: unexpectedOperation,
  getTeamsByUserId: unexpectedOperation,
  getUserById: unexpectedOperation,
  hasTeamAccess: unexpectedOperation,
  leaveTeam: unexpectedOperation,
  switchUserTeam: unexpectedOperation,
  updateTeamById: unexpectedOperation,
  updateTeamMember: unexpectedOperation,
  updateUser: unexpectedOperation,
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({ warn() {}, info() {} }),
}));
mock.module("@midday/cache/team-cache", () => ({
  teamCache: {
    get: unexpectedOperation,
    set: unexpectedOperation,
    invalidateForUser: unexpectedOperation,
  },
}));
mock.module("@midday/cache/replication-cache", () => ({
  replicationCache: { get: unexpectedOperation, set: unexpectedOperation },
}));
mock.module("@api/services/supabase", () => ({
  createClient: unexpectedOperation,
  createAdminClient: unexpectedOperation,
}));
mock.module("@api/services/resend", () => ({
  resend: { contacts: { remove: unexpectedOperation } },
}));
mock.module("@midday/job-client", () => ({
  triggerJob: unexpectedOperation,
}));
mock.module("@trigger.dev/sdk", () => ({
  tasks: { trigger: unexpectedOperation },
}));

const { userRouter } = await import("../../trpc/routers/user");
const { teamRouter } = await import("../../trpc/routers/team");
type RequestContext = Awaited<
  ReturnType<typeof import("../../trpc/init").createTRPCContext>
>;

function context(session: Session | null): RequestContext {
  return {
    session,
    db,
    supabase: {} as RequestContext["supabase"],
    geo: {
      country: null,
      city: null,
      region: null,
      continent: null,
      locale: null,
      timezone: null,
      ip: null,
    },
    requestId: "auth-regression-test",
  };
}

beforeEach(() => {
  findInvites.mockClear();
  findInvite.mockClear();
  insertMembership.mockClear();
  deleteInvite.mockClear();
});

describe("signed access-token identity", () => {
  it.each([
    "ES256",
    "RS256",
    "HS256",
  ] as const)("preserves valid %s sessions and display names", async (algorithm) => {
    const token = await signAccessToken(
      { user_metadata: { full_name: "Local User" } },
      algorithm,
    );

    expect(await verifyAccessToken(token)).toEqual({
      user: { id: actorId, email: actorEmail, full_name: "Local User" },
    });
  });

  it.each([
    "ES256",
    "HS256",
  ] as const)("does not promote editable metadata to email identity for %s tokens", async (algorithm) => {
    const token = await signAccessToken(
      { user_metadata: { email: inviteeEmail, full_name: "Local User" } },
      algorithm,
    );
    const session = await verifyAccessToken(token);

    expect(session?.user.id).toBe(actorId);
    expect(session?.user.email).toBe(actorEmail);
    expect(session?.user.full_name).toBe("Local User");
  });

  it("does not fall back to metadata when the authoritative email is missing", async () => {
    const token = await signAccessToken({
      email: undefined,
      user_metadata: { email: inviteeEmail },
    });
    const session = await verifyAccessToken(token);

    expect(session?.user.id).toBe(actorId);
    expect(session?.user.email).toBeUndefined();
  });

  it("does not treat a non-string email claim as an email credential", async () => {
    const token = await signAccessToken({
      email: { address: inviteeEmail },
      user_metadata: { email: inviteeEmail },
    });

    expect((await verifyAccessToken(token))?.user.email).toBeUndefined();
  });

  it.each([
    "ES256",
    "HS256",
  ] as const)("rejects an expired %s token even with a genuine signature", async (algorithm) => {
    const token = await signAccessToken(
      { exp: Math.floor(Date.now() / 1000) - 60 },
      algorithm,
    );

    expect(await verifyAccessToken(token)).toBeNull();
  });

  it("rejects a not-yet-valid genuinely signed token", async () => {
    const token = await signAccessToken({
      nbf: Math.floor(Date.now() / 1000) + 60,
    });

    expect(await verifyAccessToken(token)).toBeNull();
  });

  it("rejects a modified asymmetric signature", async () => {
    const token = await signAccessToken();
    const [header, payload, signature] = token.split(".");
    const replacement = signature!.startsWith("a") ? "b" : "a";
    const modified = `${header}.${payload}.${replacement}${signature!.slice(1)}`;

    expect(await verifyAccessToken(modified)).toBeNull();
  });

  it("rejects a token signed with an unrelated shared secret", async () => {
    const token = await new SignJWT({ sub: actorId, email: inviteeEmail })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("unrelated-local-test-secret"));

    expect(await verifyAccessToken(token)).toBeNull();
  });

  it.each([
    undefined,
    "",
    "not-a-jwt",
  ])("rejects an absent or malformed token: %s", async (token) => {
    expect(await verifyAccessToken(token)).toBeNull();
  });
});

describe("invitation authorization with real signed identity", () => {
  it.each([
    "ES256",
    "HS256",
  ] as const)("%s metadata cannot list another email's pending owner invitations", async (algorithm) => {
    const session = await verifyAccessToken(
      await signAccessToken(
        { user_metadata: { email: inviteeEmail } },
        algorithm,
      ),
    );
    const result = await userRouter.createCaller(context(session)).invites();

    expect(result).toEqual([]);
    expect(findInvites).toHaveBeenCalledTimes(1);
    expect(
      dialect.sqlToQuery(findInvites.mock.calls[0]![0].where).params,
    ).toEqual([actorEmail]);
    expect(insertMembership).not.toHaveBeenCalled();
  });

  it.each([
    "ES256",
    "HS256",
  ] as const)("%s metadata cannot accept another email's owner invitation", async (algorithm) => {
    const session = await verifyAccessToken(
      await signAccessToken(
        { user_metadata: { email: inviteeEmail } },
        algorithm,
      ),
    );

    await expect(
      teamRouter.createCaller(context(session)).acceptInvite({ id: inviteId }),
    ).rejects.toThrow("Invite was sent to a different email address");
    expect(findInvite).toHaveBeenCalledTimes(1);
    expect(insertMembership).not.toHaveBeenCalled();
    expect(deleteInvite).not.toHaveBeenCalled();
  });

  it("lists no invitations when only metadata and profile emails are present", async () => {
    const session = await verifyAccessToken(
      await signAccessToken({
        email: undefined,
        user_metadata: { email: inviteeEmail },
      }),
    );

    expect(await userRouter.createCaller(context(session)).invites()).toEqual(
      [],
    );
    expect(findInvites).not.toHaveBeenCalled();
  });

  it("fails closed before querying an invite when the authoritative email is missing", async () => {
    const session = await verifyAccessToken(
      await signAccessToken({
        email: undefined,
        user_metadata: { email: inviteeEmail },
      }),
    );

    await expect(
      teamRouter.createCaller(context(session)).acceptInvite({ id: inviteId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Email is required to accept an invite",
    });
    expect(findInvite).not.toHaveBeenCalled();
    expect(insertMembership).not.toHaveBeenCalled();
    expect(deleteInvite).not.toHaveBeenCalled();
  });

  it("still lists and accepts an invitation for the authoritative account email", async () => {
    const session = await verifyAccessToken(
      await signAccessToken({
        email: inviteeEmail,
        user_metadata: { email: actorEmail },
      }),
    );

    expect(await userRouter.createCaller(context(session)).invites()).toEqual([
      listedInvite,
    ]);
    expect(
      await teamRouter
        .createCaller(context(session))
        .acceptInvite({ id: inviteId }),
    ).toEqual(invite);
    expect(insertMembership).toHaveBeenCalledWith({
      userId: actorId,
      role: "owner",
      teamId: invitedTeamId,
    });
    expect(deleteInvite).toHaveBeenCalledTimes(1);
  });
});
