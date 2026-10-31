import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import type { Session } from "@api/utils/auth";
import type { Database } from "@midday/db/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { actorEmail, actorId, signAccessToken } from "./jwt-fixture";

const teamId = "22222222-2222-4222-8222-222222222222";
const otherTeamId = "33333333-3333-4333-8333-333333333333";
const apiToken = `mid_${"a".repeat(64)}`;
const oauthToken = "mid_access_token_local-test-token";
const primary = {} as Database;
const replica = { usePrimaryOnly: () => primary } as unknown as Database;

function makeUser(activeTeamId: string | null = teamId) {
  return {
    id: actorId,
    email: actorEmail,
    fullName: "Local User",
    teamId: activeTeamId,
  };
}

function makeApiKey(scopes = ["transactions.read"]) {
  return { id: "key-1", userId: actorId, teamId, scopes };
}

function makeOAuthToken() {
  return {
    teamId,
    user: { id: actorId, email: actorEmail, fullName: "Local User" },
    scopes: ["transactions.read"],
    applicationId: "application-1",
    application: { clientId: "client-1", name: "Local Application" },
  };
}

let user: ReturnType<typeof makeUser> | undefined;
let apiKey: ReturnType<typeof makeApiKey> | undefined;
let oauth: ReturnType<typeof makeOAuthToken> | null;
let memberships = new Set<string>();
const staleUser = makeUser();
const staleApiKey = makeApiKey(["apis.all"]);

const getUserById = mock(async (db: Database, id: string) =>
  id === actorId ? (db === primary ? user : staleUser) : undefined,
);
const getApiKeyByToken = mock(async (db: Database, _keyHash: string) =>
  db === primary ? apiKey : staleApiKey,
);
const validateAccessToken = mock(async (db: Database, _token: string) =>
  db === primary ? oauth : makeOAuthToken(),
);
const hasTeamAccess = mock(async (db: Database, id: string, userId: string) =>
  db === primary ? userId === actorId && memberships.has(id) : true,
);
const updateApiKeyLastUsedAt = mock(async (_db: Database, _id: string) => {});
mock.module("@midday/db/queries", () => ({
  getUserById,
  getApiKeyByToken,
  validateAccessToken,
  hasTeamAccess,
  updateApiKeyLastUsedAt,
}));

// Model a successful pre-revocation request that warmed both 30-minute caches.
const keyCacheGet = mock(async () => staleApiKey);
const userCacheGet = mock(async () => staleUser);
mock.module("@midday/cache/api-key-cache", () => ({
  apiKeyCache: { get: keyCacheGet, set: mock(async () => {}) },
}));
mock.module("@midday/cache/user-cache", () => ({
  userCache: { get: userCacheGet, set: mock(async () => {}) },
}));

const { withAuth } = await import("../../rest/middleware/auth");
const protectedHandler = mock(() => {});

function createApp(db = replica) {
  const app = new Hono<{
    Variables: {
      db: Database;
      teamId: string | null;
      session: Session;
      scopes: string[];
    };
  }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.use("*", withAuth);
  app.get("/", (c) => {
    protectedHandler();
    return c.json({
      teamId: c.get("teamId"),
      session: c.get("session"),
      scopes: c.get("scopes"),
      usesOriginalDb: c.get("db") === db,
    });
  });
  app.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "Authorization lookup failed" }, 500),
  );
  return app;
}

function request(token: string, db = replica) {
  return createApp(db).request("/", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  user = makeUser();
  apiKey = makeApiKey();
  oauth = makeOAuthToken();
  memberships = new Set([teamId]);
  for (const fn of [
    getUserById,
    getApiKeyByToken,
    validateAccessToken,
    hasTeamAccess,
    updateApiKeyLastUsedAt,
    keyCacheGet,
    userCacheGet,
    protectedHandler,
  ]) {
    fn.mockClear();
  }
});

describe("REST JWT authorization", () => {
  it("allows a signed JWT with current primary membership and preserves scopes/routing", async () => {
    const response = await request(await signAccessToken());
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.teamId).toBe(teamId);
    expect(result.session.user.id).toBe(actorId);
    expect(result.scopes).toContain("transactions.read");
    expect(result.scopes).toContain("transactions.write");
    expect(result.usesOriginalDb).toBe(true);
    expect(getUserById).toHaveBeenCalledWith(primary, actorId);
    expect(hasTeamAccess).toHaveBeenCalledWith(primary, teamId, actorId);
    expect(protectedHandler).toHaveBeenCalledTimes(1);
  });

  it("rejects an owner-removed member even when their active team is unchanged", async () => {
    memberships.clear();
    const response = await request(await signAccessToken());

    expect(response.status).toBe(403);
    expect(hasTeamAccess).toHaveBeenCalledWith(primary, teamId, actorId);
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("does not substitute membership of another team for the selected team", async () => {
    memberships = new Set([otherTeamId]);
    const response = await request(await signAccessToken());

    expect(response.status).toBe(403);
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("keeps a new user's own profile available with no active team", async () => {
    user = makeUser(null);
    memberships.clear();
    const response = await request(await signAccessToken());

    expect(response.status).toBe(200);
    expect((await response.json()).teamId).toBeNull();
    expect(hasTeamAccess).not.toHaveBeenCalled();
  });

  it("rejects a deleted user despite a stale replica and user cache", async () => {
    user = undefined;
    const response = await request(await signAccessToken());

    expect(response.status).toBe(401);
    expect(getUserById).toHaveBeenCalledWith(primary, actorId);
    expect(userCacheGet).not.toHaveBeenCalled();
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("also works when the configured database is already primary-only", async () => {
    const response = await request(await signAccessToken(), primary);

    expect(response.status).toBe(200);
    expect(hasTeamAccess).toHaveBeenCalledWith(primary, teamId, actorId);
  });
});

describe("REST OAuth authorization", () => {
  it("authorizes the token's team after the user selects another team", async () => {
    user = makeUser(otherTeamId);
    const response = await request(oauthToken);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.teamId).toBe(teamId);
    expect(result.session.oauth).toEqual({
      applicationId: "application-1",
      clientId: "client-1",
      applicationName: "Local Application",
    });
    expect(result.scopes).toEqual(["transactions.read"]);
    expect(result.usesOriginalDb).toBe(true);
    expect(validateAccessToken).toHaveBeenCalledWith(primary, oauthToken);
    expect(hasTeamAccess).toHaveBeenCalledWith(primary, teamId, actorId);
  });

  it("rejects a token after the user leaves its team, even with a warm cache", async () => {
    user = makeUser(null);
    memberships.clear();
    const response = await request(oauthToken);

    expect(response.status).toBe(403);
    expect(userCacheGet).not.toHaveBeenCalled();
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("rejects a revoked token instead of trusting a stale replica", async () => {
    oauth = null;
    const response = await request(oauthToken);

    expect(response.status).toBe(401);
    expect(validateAccessToken).toHaveBeenCalledWith(primary, oauthToken);
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("rejects a deleted user even if token validation returned a user snapshot", async () => {
    user = undefined;
    const response = await request(oauthToken);

    expect(response.status).toBe(401);
    expect(userCacheGet).not.toHaveBeenCalled();
    expect(protectedHandler).not.toHaveBeenCalled();
  });
});

describe("REST API key authorization", () => {
  it("requires a current key, user and membership while preserving the key's scopes", async () => {
    const response = await request(apiToken);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.teamId).toBe(teamId);
    expect(result.scopes).toEqual(["transactions.read"]);
    expect(result.usesOriginalDb).toBe(true);
    expect(getApiKeyByToken).toHaveBeenCalledWith(
      primary,
      createHash("sha256").update(apiToken).digest("hex"),
    );
    expect(getUserById).toHaveBeenCalledWith(primary, actorId);
    expect(hasTeamAccess).toHaveBeenCalledWith(primary, teamId, actorId);
    expect(updateApiKeyLastUsedAt).toHaveBeenCalledWith(replica, "key-1");
  });

  it("keeps keys bound to their own team instead of the user's active team", async () => {
    user = makeUser(otherTeamId);
    const response = await request(apiToken);

    expect(response.status).toBe(200);
    expect((await response.json()).teamId).toBe(teamId);
    expect(hasTeamAccess).toHaveBeenCalledWith(primary, teamId, actorId);
  });

  it("rejects a removed member even when both auth caches contain old records", async () => {
    memberships.clear();
    const response = await request(apiToken);

    expect(response.status).toBe(403);
    expect(keyCacheGet).not.toHaveBeenCalled();
    expect(userCacheGet).not.toHaveBeenCalled();
    expect(updateApiKeyLastUsedAt).not.toHaveBeenCalled();
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("rejects a deleted key even if a late cache write restored its old record", async () => {
    apiKey = undefined;
    const response = await request(apiToken);

    expect(response.status).toBe(401);
    expect(keyCacheGet).not.toHaveBeenCalled();
    expect(updateApiKeyLastUsedAt).not.toHaveBeenCalled();
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("uses reduced primary scopes instead of a stale all-access cache entry", async () => {
    apiKey = makeApiKey(["transactions.read"]);
    const response = await request(apiToken);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.scopes).toEqual(["transactions.read"]);
    expect(result.scopes).not.toContain("transactions.write");
    expect(keyCacheGet).not.toHaveBeenCalled();
  });

  it("rejects a deleted key owner despite a warm user cache", async () => {
    user = undefined;
    const response = await request(apiToken);

    expect(response.status).toBe(401);
    expect(userCacheGet).not.toHaveBeenCalled();
    expect(updateApiKeyLastUsedAt).not.toHaveBeenCalled();
    expect(protectedHandler).not.toHaveBeenCalled();
  });
});

describe("REST authorization failures", () => {
  it.each([
    [undefined, "Authorization header required"],
    ["Basic not-a-bearer", "Invalid authorization scheme"],
    ["Bearer", "Token required"],
    ["Bearer invalid-token", "Invalid token format"],
  ] as const)("rejects invalid credentials: %s", async (authorization, message) => {
    const response = await createApp().request("/", {
      headers: authorization ? { Authorization: authorization } : undefined,
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe(message);
    expect(protectedHandler).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(getApiKeyByToken).not.toHaveBeenCalled();
  });

  it("fails closed when the authoritative membership lookup errors", async () => {
    hasTeamAccess.mockRejectedValueOnce(new Error("membership query failed"));
    const response = await request(apiToken);

    expect(response.status).toBe(500);
    expect(updateApiKeyLastUsedAt).not.toHaveBeenCalled();
    expect(protectedHandler).not.toHaveBeenCalled();
  });
});
