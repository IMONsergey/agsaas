import { verifyAccessToken } from "@api/utils/auth";
import { MfaPolicyError, requireSessionMfa } from "@api/utils/mfa";
import { expandScopes } from "@api/utils/scopes";
import { isValidApiKeyFormat } from "@db/utils/api-keys";
import type { Database, DatabaseWithPrimary } from "@midday/db/client";
import {
  getApiKeyByToken,
  getUserById,
  hasTeamAccess,
  updateApiKeyLastUsedAt,
  validateAccessToken,
} from "@midday/db/queries";
import { hash } from "@midday/encryption";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

async function requireTeamMembership(
  db: Database,
  teamId: string | null,
  userId: string,
) {
  // A new user can access their own profile before choosing a team.
  if (teamId !== null && !(await hasTeamAccess(db, teamId, userId))) {
    throw new HTTPException(403, {
      message: "No permission to access this team",
    });
  }
}

export const withAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    throw new HTTPException(401, { message: "Authorization header required" });
  }

  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer") {
    throw new HTTPException(401, { message: "Invalid authorization scheme" });
  }

  if (!token) {
    throw new HTTPException(401, { message: "Token required" });
  }

  const db = c.get("db") as DatabaseWithPrimary;
  // Revocation, scope changes and membership removal must not be hidden by
  // replica lag or stale cross-request caches. Keep downstream read routing.
  const primaryOnly = db.usePrimaryOnly;
  const authDb = primaryOnly ? primaryOnly.call(db) : db;

  // Handle Supabase JWT tokens (try to verify as JWT first)
  const supabaseSession = await verifyAccessToken(token);
  if (supabaseSession) {
    // Get user from database to get team info
    const user = await getUserById(authDb, supabaseSession.user.id);

    if (!user) {
      throw new HTTPException(401, { message: "User not found" });
    }

    await requireTeamMembership(authDb, user.teamId, user.id);

    try {
      await requireSessionMfa(supabaseSession);
    } catch (error) {
      if (error instanceof MfaPolicyError) {
        throw new HTTPException(error.reason === "required" ? 403 : 503, {
          message: error.message,
        });
      }
      throw error;
    }

    const session = {
      aal: supabaseSession.aal,
      teamId: user.teamId,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.fullName,
      },
    };

    c.set("session", session);
    c.set("teamId", session.teamId);
    c.set("user", user);
    c.set("scopes", expandScopes(["apis.all"]));

    await next();
    return;
  }

  // Handle OAuth access tokens (start with mid_access_token_)
  if (token.startsWith("mid_access_token_")) {
    const tokenData = await validateAccessToken(authDb, token);

    if (!tokenData?.user) {
      throw new HTTPException(401, {
        message: "Invalid or expired access token",
      });
    }

    const user = await getUserById(authDb, tokenData.user.id);

    if (!user) {
      throw new HTTPException(401, { message: "User not found" });
    }

    await requireTeamMembership(authDb, tokenData.teamId, tokenData.user.id);

    const session = {
      teamId: tokenData.teamId,
      user: {
        id: tokenData.user.id,
        email: tokenData.user.email,
        full_name: tokenData.user.fullName,
      },
      oauth: {
        applicationId: tokenData.applicationId,
        clientId: tokenData.application?.clientId,
        applicationName: tokenData.application?.name,
      },
    };

    c.set("session", session);
    c.set("teamId", session.teamId);
    c.set("user", user);
    c.set("scopes", expandScopes(tokenData.scopes ?? []));

    await next();
    return;
  }

  // Handle API keys (start with mid_ but not mid_access_token_)
  if (!token.startsWith("mid_") || !isValidApiKeyFormat(token)) {
    throw new HTTPException(401, { message: "Invalid token format" });
  }

  const keyHash = hash(token);

  const apiKey = await getApiKeyByToken(authDb, keyHash);

  if (!apiKey) {
    throw new HTTPException(401, { message: "Invalid API key" });
  }

  const user = await getUserById(authDb, apiKey.userId);

  if (!user) {
    throw new HTTPException(401, { message: "User not found" });
  }

  await requireTeamMembership(authDb, apiKey.teamId, user.id);

  const session = {
    teamId: apiKey.teamId,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
    },
  };

  c.set("session", session);
  c.set("teamId", session.teamId);
  c.set("user", user);
  c.set("scopes", expandScopes(apiKey.scopes ?? []));

  // Update last used at
  updateApiKeyLastUsedAt(db, apiKey.id);

  await next();
};
