import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "@midday/db/client";
import { generateFileKey } from "@midday/encryption";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "../../rest/types";
import {
  actorEmail,
  actorId,
  sessionId,
  sessionState,
  signAccessToken,
} from "./jwt-fixture";

const teamA = "22222222-2222-4222-8222-222222222222";
const teamB = "33333333-3333-4333-8333-333333333333";
const apiToken = "mid_" + "a".repeat(64);
const oauthToken = "mid_access_token_file-access-fixture";
const previousFileSecret = process.env.FILE_KEY_SECRET;
process.env.FILE_KEY_SECRET = "file-route-fixture-secret-never-deployed";

const primary = {} as Database;
const replica = { usePrimaryOnly: () => primary } as unknown as Database;
let memberships = new Set([teamA, teamB]);
let userExists = true;
let pendingDeletion = false;
let scopes: string[] = ["users.read"];
let factors: Array<{ status: "verified" | "unverified" }> = [];
let factorFailure = false;
let budgetFailure: "none" | "limited" | "unavailable" = "none";
class TestBudgetExceededError extends Error {
  constructor() {
    super("Request budget exceeded");
  }
}
const consumeRequestBudget = mock(
  async (
    _db: Database,
    _input: { userId: string; teamId?: string | null; cost?: number },
  ) => {
    if (budgetFailure === "limited") throw new TestBudgetExceededError();
    if (budgetFailure === "unavailable")
      throw new Error("private-db-budget-details");
  },
);
mock.module("@midday/db/queries/resource-admission", () => ({
  consumeRequestBudget,
  ResourceBudgetExceededError: TestBudgetExceededError,
}));

function profile(teamId: string | null = teamA) {
  return {
    id: actorId,
    email: actorEmail,
    fullName: "File fixture",
    teamId,
    deletionStartedAt: pendingDeletion ? "2026-01-01T00:00:00Z" : null,
    avatarUrl: null,
    locale: "en-US",
    timeFormat: 24,
    dateFormat: "yyyy-MM-dd",
    weekStartsOnMonday: false,
    timezone: "UTC",
    timezoneAutoSync: true,
    team: teamId
      ? {
          id: teamId,
          name: teamId === teamA ? "Team A" : "Team B",
          logoUrl: null,
          plan: "starter",
        }
      : null,
  };
}
const getUserById = mock(
  async (db: Database, id: string, context?: { teamId: string | null }) => {
    if (id !== actorId || (db === primary && !userExists)) return undefined;
    return profile(context ? context.teamId : teamA);
  },
);
const hasTeamAccess = mock(
  async (db: Database, teamId: string, userId: string) =>
    db === primary ? userId === actorId && memberships.has(teamId) : true,
);
const getApiKeyByToken = mock(async () => ({
  id: "key-fixture",
  userId: actorId,
  teamId: teamB,
  scopes,
}));
const validateAccessToken = mock(async () => ({
  teamId: teamB,
  user: { id: actorId, email: actorEmail, fullName: "File fixture" },
  scopes,
  applicationId: "app-fixture",
  application: { clientId: "client-fixture", name: "File fixture" },
}));
const listFactors = mock(async () => {
  if (factorFailure) throw new Error("private-provider-details");
  return { data: { factors }, error: null };
});
mock.module("@midday/db/client", () => ({ db: replica }));
mock.module("@midday/db/queries", () => ({
  getUserById,
  hasTeamAccess,
  getApiKeyByToken,
  validateAccessToken,
  getUserTeamId: async () => {
    throw new Error(
      "Unexpected active-team fallback in file authorization fixture",
    );
  },
  updateApiKeyLastUsedAt: async () => {},
  updateUser: async () => ({}),
}));
mock.module("@api/services/supabase", () => ({
  createAdminClient: async () => ({
    auth: { admin: { mfa: { listFactors } } },
  }),
}));
mock.module("@midday/cache/replication-cache", () => ({
  replicationCache: { get: async () => false, set: async () => {} },
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({ warn() {}, info() {} }),
  logger: { warn() {}, info() {} },
}));

const { withFileAuth } = await import("../../rest/middleware/file-auth");
const { withAuth } = await import("../../rest/middleware/auth");
const { requireFileAccess } = await import("../../utils/file-access");
const { usersRouter } = await import("../../rest/routers/users");

function createApp() {
  const app = new Hono<Context>();
  app.use("*", async (c, next) => {
    c.set("db", replica);
    await next();
  });
  app.get("/proxy", withFileAuth, (c) => c.json({ teamId: c.get("teamId") }));
  app.get("/invoice", async (c) =>
    c.json(await requireFileAccess(c, "invoices.read")),
  );
  app.use("/users/*", withAuth);
  app.route("/users", usersRouter);
  app.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "File authorization failed" }, 500),
  );
  return app;
}
function proxyRequest(
  pathTeam: string,
  options: {
    fk?: string;
    bearer?: string;
    folder?: string;
  } = {},
) {
  const query = new URLSearchParams({
    filePath: pathTeam + "/" + (options.folder ?? "inbox") + "/fixture.png",
  });
  if (options.fk) query.set("fk", options.fk);
  return createApp().request("/proxy?" + query, {
    headers: options.bearer
      ? { Authorization: "Bearer " + options.bearer }
      : {},
  });
}

beforeEach(() => {
  memberships = new Set([teamA, teamB]);
  userExists = true;
  pendingDeletion = false;
  factors = [];
  factorFailure = false;
  budgetFailure = "none";
  consumeRequestBudget.mockClear();
  scopes = ["users.read"];
  for (const fn of [getUserById, hasTeamAccess, listFactors]) fn.mockClear();
});
afterAll(() => {
  if (previousFileSecret === undefined) delete process.env.FILE_KEY_SECRET;
  else process.env.FILE_KEY_SECRET = previousFileSecret;
});

describe("file access revocation and credential scopes", () => {
  it("allows a signed user key only while the primary membership exists", async () => {
    const fk = await generateFileKey({
      sessionId,
      userId: actorId,
      teamId: teamA,
      aal: "aal1",
    });
    expect((await proxyRequest(teamA, { fk })).status).toBe(200);
    memberships.delete(teamA);
    expect((await proxyRequest(teamA, { fk })).status).toBe(401);
    expect(hasTeamAccess).toHaveBeenLastCalledWith(primary, teamA, actorId);
    expect((await proxyRequest(teamB, { fk })).status).not.toBe(200);
  });

  it("rejects a valid signed file key immediately after the browser session is revoked", async () => {
    const fk = await generateFileKey({
      sessionId,
      userId: actorId,
      teamId: teamA,
      aal: "aal1",
    });
    expect((await proxyRequest(teamA, { fk })).status).toBe(200);
    sessionState.active = false;
    expect((await proxyRequest(teamA, { fk })).status).toBe(401);
  });

  it("rejects deleted profiles and durable pending deletion despite a stale replica", async () => {
    const fk = await generateFileKey({
      sessionId,
      userId: actorId,
      teamId: teamA,
      aal: "aal1",
    });
    pendingDeletion = true;
    expect((await proxyRequest(teamA, { fk })).status).toBe(401);
    pendingDeletion = false;
    userExists = false;
    expect((await proxyRequest(teamA, { fk })).status).toBe(401);
    expect(getUserById).toHaveBeenLastCalledWith(primary, actorId);
  });

  it("applies current MFA policy to existing AAL1 file keys", async () => {
    const fk = await generateFileKey({
      sessionId,
      userId: actorId,
      teamId: teamA,
      aal: "aal1",
    });
    factors = [{ status: "verified" }];
    expect((await proxyRequest(teamA, { fk })).status).toBe(403);
    factorFailure = true;
    const failed = await proxyRequest(teamA, { fk });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private-provider-details");
  });

  it("does not substitute the profile's active team for a Bearer grant", async () => {
    scopes = ["documents.read"];
    expect((await proxyRequest(teamB, { bearer: apiToken })).status).toBe(200);
    expect((await proxyRequest(teamA, { bearer: apiToken })).status).not.toBe(
      200,
    );
    expect((await proxyRequest(teamB, { bearer: oauthToken })).status).toBe(
      200,
    );
  });

  it("requires the matching read scope and preserves OAuth/API use during Auth outage", async () => {
    factorFailure = true;
    expect((await proxyRequest(teamB, { bearer: apiToken })).status).toBe(403);
    scopes = ["invoices.read"];
    expect(
      (await proxyRequest(teamB, { bearer: apiToken, folder: "invoices" }))
        .status,
    ).toBe(200);
    expect((await proxyRequest(teamB, { bearer: apiToken })).status).toBe(403);
    scopes = ["documents.read"];
    expect(
      (
        await createApp().request("/invoice", {
          headers: { Authorization: "Bearer " + oauthToken },
        })
      ).status,
    ).toBe(403);
    expect(listFactors).not.toHaveBeenCalled();
  });

  it("accepts an authenticated MFA-off browser Bearer without requiring a file key", async () => {
    const token = await signAccessToken({ aal: "aal1" });
    expect((await proxyRequest(teamA, { bearer: token })).status).toBe(200);
  });

  it("fails closed on missing or modified capabilities", async () => {
    expect((await proxyRequest(teamA)).status).toBe(401);
    expect((await proxyRequest(teamA, { fk: "invalid-key" })).status).toBe(401);
  });
});

describe("file HTTP admission follows verified identity", () => {
  for (const mode of ["file-key", "browser", "api", "oauth"] as const) {
    it(`returns 429 and retry guidance before exposing a file for ${mode}`, async () => {
      scopes = ["documents.read"];
      budgetFailure = "limited";
      const options =
        mode === "file-key"
          ? {
              fk: await generateFileKey({
                sessionId,
                userId: actorId,
                teamId: teamA,
                aal: "aal1",
              }),
            }
          : {
              bearer:
                mode === "browser"
                  ? await signAccessToken({ aal: "aal1" })
                  : mode === "api"
                    ? apiToken
                    : oauthToken,
            };
      const teamId = mode === "api" || mode === "oauth" ? teamB : teamA;
      const response = await proxyRequest(teamId, options);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(await response.json()).toMatchObject({
        code: "RATE_LIMIT_EXCEEDED",
      });
      expect(consumeRequestBudget).toHaveBeenCalledTimes(1);
      expect(consumeRequestBudget).toHaveBeenCalledWith(replica, {
        userId: actorId,
        teamId,
        cost: 1,
      });
    });
  }
  it("does not call admission for a revoked signed identity", async () => {
    const fk = await generateFileKey({
      sessionId,
      userId: actorId,
      teamId: teamA,
      aal: "aal1",
    });
    memberships.delete(teamA);
    expect((await proxyRequest(teamA, { fk })).status).toBe(401);
    expect(consumeRequestBudget).not.toHaveBeenCalled();
  });
  it("fails closed without exposing the database error when admission is unavailable", async () => {
    budgetFailure = "unavailable";
    const fk = await generateFileKey({
      sessionId,
      userId: actorId,
      teamId: teamA,
      aal: "aal1",
    });
    const response = await proxyRequest(teamA, { fk });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("ADMISSION_UNAVAILABLE");
    expect(body).not.toContain("private-db-budget-details");
  });
});

describe("REST profile does not mint file capabilities", () => {
  for (const bearer of [apiToken, oauthToken]) {
    it(
      "returns only the credential team and a null file key for " +
        bearer.slice(0, 16),
      async () => {
        const response = await createApp().request("/users/me", {
          headers: { Authorization: "Bearer " + bearer },
        });
        const body = (await response.json()) as {
          team: { id: string };
          fileKey: unknown;
        };
        expect(response.status).toBe(200);
        expect(body.team.id).toBe(teamB);
        expect(body.fileKey).toBeNull();
        expect(getUserById).toHaveBeenLastCalledWith(replica, actorId, {
          teamId: teamB,
        });
      },
    );
  }

  it("does not restore a file capability in the users.write response", async () => {
    scopes = ["users.write"];
    const response = await createApp().request("/users/me", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fullName: "Updated fixture" }),
    });
    const body = (await response.json()) as {
      team: { id: string };
      fileKey: unknown;
    };
    expect(response.status).toBe(200);
    expect(body.team.id).toBe(teamB);
    expect(body.fileKey).toBeNull();
  });
});
