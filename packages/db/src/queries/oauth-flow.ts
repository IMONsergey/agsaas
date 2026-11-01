import { createHash } from "node:crypto";
import { hash } from "@midday/encryption";
import { and, desc, eq, gt, gte, isNull, lte, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  oauthAccessTokens,
  oauthApplications,
  oauthAuthorizationCodes,
  users,
  usersOnTeam,
} from "../schema";

export type CreateAuthorizationCodeParams = {
  applicationId: string;
  userId: string;
  teamId: string;
  scopes: string[];
  redirectUri: string;
  codeChallenge?: string;
};

export type CreateAccessTokenParams = {
  applicationId: string;
  userId: string;
  teamId: string;
  scopes: string[];
  expiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
};

export type RefreshAccessTokenParams = {
  refreshToken: string;
  applicationId: string;
  scopes?: string[];
};

export type RevokeTokenParams = {
  token: string;
  applicationId?: string;
};

// Create authorization code
export async function createAuthorizationCode(
  db: Database,
  params: CreateAuthorizationCodeParams,
) {
  const code = `mid_authorization_code_${nanoid(32)}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  const [result] = await db
    .insert(oauthAuthorizationCodes)
    .values({
      code,
      applicationId: params.applicationId,
      userId: params.userId,
      teamId: params.teamId,
      scopes: params.scopes,
      redirectUri: params.redirectUri,
      expiresAt: expiresAt.toISOString(),
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallenge ? "S256" : null,
    })
    .returning({
      id: oauthAuthorizationCodes.id,
      code: oauthAuthorizationCodes.code,
      expiresAt: oauthAuthorizationCodes.expiresAt,
    });

  return result;
}

// Consume and issue in one primary transaction. A row lock makes concurrent
// exchange single-use; a failed token insert rolls the consumption back.
export async function exchangeAuthorizationCode(
  db: Database,
  code: string,
  redirectUri: string,
  applicationId: string,
  codeVerifier?: string,
) {
  const outcome = await db.transaction(async (tx) => {
    const [authCode] = await tx
      .select({
        id: oauthAuthorizationCodes.id,
        applicationId: oauthAuthorizationCodes.applicationId,
        userId: oauthAuthorizationCodes.userId,
        teamId: oauthAuthorizationCodes.teamId,
        scopes: oauthAuthorizationCodes.scopes,
        redirectUri: oauthAuthorizationCodes.redirectUri,
        expiresAt: oauthAuthorizationCodes.expiresAt,
        used: oauthAuthorizationCodes.used,
        codeChallenge: oauthAuthorizationCodes.codeChallenge,
        createdAt: oauthAuthorizationCodes.createdAt,
      })
      .from(oauthAuthorizationCodes)
      .innerJoin(users, eq(oauthAuthorizationCodes.userId, users.id))
      .innerJoin(
        usersOnTeam,
        and(
          eq(usersOnTeam.userId, oauthAuthorizationCodes.userId),
          eq(usersOnTeam.teamId, oauthAuthorizationCodes.teamId),
        ),
      )
      .innerJoin(
        oauthApplications,
        eq(oauthApplications.id, oauthAuthorizationCodes.applicationId),
      )
      .where(
        and(
          eq(oauthAuthorizationCodes.code, code),
          eq(oauthApplications.active, true),
          isNull(users.deletionStartedAt),
        ),
      )
      .limit(1)
      .for("update", { of: oauthAuthorizationCodes });

    if (!authCode) throw new Error("Invalid authorization code");
    if (authCode.applicationId !== applicationId) {
      throw new Error("Authorization code does not belong to this application");
    }
    if (new Date(authCode.expiresAt).getTime() <= Date.now()) {
      throw new Error("Authorization code expired");
    }
    if (authCode.redirectUri !== redirectUri) {
      throw new Error("Invalid redirect URI");
    }
    // A caller must prove the original PKCE binding even on the replay path.
    if (authCode.codeChallenge) {
      if (!codeVerifier) {
        throw new Error(
          "Code verifier is required when code challenge is present",
        );
      }
      const computedChallenge = createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      if (computedChallenge !== authCode.codeChallenge) {
        throw new Error("Invalid code verifier");
      }
    }

    if (authCode.used) {
      await revokeTokensByAuthorizationCode(tx, {
        applicationId: authCode.applicationId,
        userId: authCode.userId,
        teamId: authCode.teamId,
        createdAt: authCode.createdAt,
      });
      // Return the rejection so replay revocation commits. Throwing inside the
      // transaction would silently roll back this security side effect.
      return {
        error: "Authorization code already used - related tokens revoked",
      } as const;
    }

    await tx
      .update(oauthAuthorizationCodes)
      .set({ used: true })
      .where(eq(oauthAuthorizationCodes.id, authCode.id));

    const accessToken = await createAccessToken(tx, {
      applicationId: authCode.applicationId,
      userId: authCode.userId,
      teamId: authCode.teamId,
      scopes: authCode.scopes,
    });
    return { accessToken } as const;
  });

  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.accessToken;
}

// Create access token
export async function createAccessToken(
  db: DatabaseOrTransaction,
  params: CreateAccessTokenParams,
) {
  const token = `mid_access_token_${nanoid(32)}`;
  const refreshToken = `mid_refresh_token_${nanoid(32)}`;
  const expiresInSeconds = params.expiresInSeconds ?? 7200; // 2 hours default
  const refreshTokenExpiresInSeconds =
    params.refreshTokenExpiresInSeconds ?? 86400 * 30; // 30 days default

  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const refreshTokenExpiresAt = new Date(
    Date.now() + refreshTokenExpiresInSeconds * 1000,
  );

  // Hash tokens before storing in database
  const tokenHash = hash(token);
  const refreshTokenHash = hash(refreshToken);

  const [result] = await db
    .insert(oauthAccessTokens)
    .values({
      token: tokenHash,
      refreshToken: refreshTokenHash,
      applicationId: params.applicationId,
      userId: params.userId,
      teamId: params.teamId,
      scopes: params.scopes,
      expiresAt: expiresAt.toISOString(),
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    })
    .returning({
      id: oauthAccessTokens.id,
      token: oauthAccessTokens.token,
      refreshToken: oauthAccessTokens.refreshToken,
      expiresAt: oauthAccessTokens.expiresAt,
      refreshTokenExpiresAt: oauthAccessTokens.refreshTokenExpiresAt,
      scopes: oauthAccessTokens.scopes,
    });

  if (!result) {
    throw new Error("Failed to create access token");
  }

  return {
    accessToken: token,
    refreshToken: refreshToken,
    expiresIn: expiresInSeconds,
    refreshTokenExpiresIn: refreshTokenExpiresInSeconds,
    scopes: result.scopes,
    tokenType: "Bearer" as const,
  };
}

// Validate access token
export async function validateAccessToken(db: Database, token: string) {
  // A retained application is company-owned, but each grant is still personal.
  // Membership removal and pending deletion must not be hidden by replica lag.
  const primaryOnly = db.usePrimaryOnly;
  const authorizationDb = primaryOnly ? primaryOnly.call(db) : db;
  // Hash the incoming token to compare with stored hash
  const tokenHash = hash(token);

  const [result] = await authorizationDb
    .select({
      id: oauthAccessTokens.id,
      token: oauthAccessTokens.token,
      applicationId: oauthAccessTokens.applicationId,
      userId: oauthAccessTokens.userId,
      teamId: oauthAccessTokens.teamId,
      scopes: oauthAccessTokens.scopes,
      expiresAt: oauthAccessTokens.expiresAt,
      revoked: oauthAccessTokens.revoked,
      user: {
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      },
      application: {
        id: oauthApplications.id,
        name: oauthApplications.name,
        clientId: oauthApplications.clientId,
        active: oauthApplications.active,
      },
    })
    .from(oauthAccessTokens)
    .innerJoin(users, eq(oauthAccessTokens.userId, users.id))
    .innerJoin(
      usersOnTeam,
      and(
        eq(usersOnTeam.userId, oauthAccessTokens.userId),
        eq(usersOnTeam.teamId, oauthAccessTokens.teamId),
      ),
    )
    .innerJoin(
      oauthApplications,
      eq(oauthAccessTokens.applicationId, oauthApplications.id),
    )
    .where(
      and(
        eq(oauthAccessTokens.token, tokenHash), // Compare with hashed token
        eq(oauthAccessTokens.revoked, false),
        gt(oauthAccessTokens.expiresAt, new Date().toISOString()),
        isNull(users.deletionStartedAt),
      ),
    )
    .limit(1);

  if (!result) {
    return null;
  }

  if (!result.application?.active) {
    return null;
  }

  // Update last used timestamp
  await authorizationDb
    .update(oauthAccessTokens)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(oauthAccessTokens.id, result.id));

  return result;
}

// Rotate the old grant and insert its replacement atomically on primary.
export async function refreshAccessToken(
  db: Database,
  params: RefreshAccessTokenParams,
) {
  const { refreshToken, applicationId, scopes } = params;
  const refreshTokenHash = hash(refreshToken);

  return db.transaction(async (tx) => {
    const [existingToken] = await tx
      .select({
        id: oauthAccessTokens.id,
        userId: oauthAccessTokens.userId,
        teamId: oauthAccessTokens.teamId,
        scopes: oauthAccessTokens.scopes,
        refreshTokenExpiresAt: oauthAccessTokens.refreshTokenExpiresAt,
      })
      .from(oauthAccessTokens)
      .innerJoin(users, eq(oauthAccessTokens.userId, users.id))
      .innerJoin(
        usersOnTeam,
        and(
          eq(usersOnTeam.userId, oauthAccessTokens.userId),
          eq(usersOnTeam.teamId, oauthAccessTokens.teamId),
        ),
      )
      .innerJoin(
        oauthApplications,
        eq(oauthApplications.id, oauthAccessTokens.applicationId),
      )
      .where(
        and(
          eq(oauthAccessTokens.refreshToken, refreshTokenHash),
          eq(oauthAccessTokens.applicationId, applicationId),
          eq(oauthAccessTokens.revoked, false),
          eq(oauthApplications.active, true),
          isNull(users.deletionStartedAt),
        ),
      )
      .limit(1)
      .for("update", { of: oauthAccessTokens });

    if (!existingToken) throw new Error("Invalid refresh token");
    if (
      !existingToken.refreshTokenExpiresAt ||
      new Date(existingToken.refreshTokenExpiresAt).getTime() <= Date.now()
    ) {
      throw new Error("Refresh token expired");
    }

    let validatedScopes = existingToken.scopes;
    if (scopes && scopes.length > 0) {
      const originalScopes = new Set(existingToken.scopes);
      if (scopes.some((scope) => !originalScopes.has(scope))) {
        throw new Error("Requested scope is not authorized for this token");
      }
      validatedScopes = scopes;
    }

    await tx
      .update(oauthAccessTokens)
      .set({ revoked: true, revokedAt: new Date().toISOString() })
      .where(eq(oauthAccessTokens.id, existingToken.id));

    return createAccessToken(tx, {
      applicationId,
      userId: existingToken.userId,
      teamId: existingToken.teamId,
      scopes: validatedScopes,
    });
  });
}

// Revoke either member of an access/refresh pair with client binding.
export async function revokeAccessToken(
  db: Database,
  params: RevokeTokenParams,
) {
  const { token, applicationId } = params;

  // Hash the incoming token to compare with stored hash
  const tokenHash = hash(token);

  const whereConditions = [
    or(
      eq(oauthAccessTokens.token, tokenHash),
      eq(oauthAccessTokens.refreshToken, tokenHash),
    ),
    eq(oauthAccessTokens.revoked, false),
  ];

  if (applicationId) {
    whereConditions.push(eq(oauthAccessTokens.applicationId, applicationId));
  }

  const [result] = await db
    .update(oauthAccessTokens)
    .set({
      revoked: true,
      revokedAt: new Date().toISOString(),
    })
    .where(and(...whereConditions))
    .returning({
      id: oauthAccessTokens.id,
      token: oauthAccessTokens.token,
    });

  return result;
}

// Get user's authorized applications
export async function getUserAuthorizedApplications(
  db: Database,
  userId: string,
  teamId: string,
) {
  return db
    .select({
      id: oauthApplications.id,
      name: oauthApplications.name,
      description: oauthApplications.description,
      overview: oauthApplications.overview,
      developerName: oauthApplications.developerName,
      logoUrl: oauthApplications.logoUrl,
      website: oauthApplications.website,
      installUrl: oauthApplications.installUrl,
      screenshots: oauthApplications.screenshots,
      scopes: oauthAccessTokens.scopes,
      lastUsedAt: oauthAccessTokens.lastUsedAt,
      createdAt: oauthAccessTokens.createdAt,
      expiresAt: oauthAccessTokens.expiresAt,
      refreshTokenExpiresAt: oauthAccessTokens.refreshTokenExpiresAt,
    })
    .from(oauthAccessTokens)
    .leftJoin(
      oauthApplications,
      eq(oauthAccessTokens.applicationId, oauthApplications.id),
    )
    .where(
      and(
        eq(oauthAccessTokens.userId, userId),
        eq(oauthAccessTokens.teamId, teamId),
        eq(oauthAccessTokens.revoked, false),
        gt(oauthAccessTokens.expiresAt, new Date().toISOString()),
      ),
    )
    .orderBy(desc(oauthAccessTokens.lastUsedAt));
}

// Check if user has ever authorized an application (including expired/revoked tokens)
export async function hasUserEverAuthorizedApp(
  db: Database,
  userId: string,
  teamId: string,
  applicationId: string,
): Promise<boolean> {
  const [token] = await db
    .select({ id: oauthAccessTokens.id })
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.userId, userId),
        eq(oauthAccessTokens.teamId, teamId),
        eq(oauthAccessTokens.applicationId, applicationId),
      ),
    )
    .limit(1);

  return !!token;
}

// Revoke all user tokens for an application
export async function revokeUserApplicationTokens(
  db: Database,
  userId: string,
  applicationId: string,
) {
  await db
    .update(oauthAccessTokens)
    .set({
      revoked: true,
      revokedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(oauthAccessTokens.userId, userId),
        eq(oauthAccessTokens.applicationId, applicationId),
        eq(oauthAccessTokens.revoked, false),
      ),
    );
}

// SECURITY: Revoke tokens potentially related to an authorization code
// This is used when authorization code reuse is detected
export async function revokeTokensByAuthorizationCode(
  db: DatabaseOrTransaction,
  authCode: {
    applicationId: string;
    userId: string;
    teamId: string;
    createdAt?: string;
  },
) {
  // Calculate time window for potential related tokens (within 10 minutes of auth code creation)
  const authCodeTime = authCode.createdAt
    ? new Date(authCode.createdAt)
    : new Date();
  const timeWindowStart = new Date(authCodeTime.getTime() - 10 * 60 * 1000); // 10 minutes before
  const timeWindowEnd = new Date(authCodeTime.getTime() + 10 * 60 * 1000); // 10 minutes after

  // Revoke tokens that match the authorization code context and were created around the same time
  const revokedTokens = await db
    .update(oauthAccessTokens)
    .set({
      revoked: true,
      revokedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(oauthAccessTokens.applicationId, authCode.applicationId),
        eq(oauthAccessTokens.userId, authCode.userId),
        eq(oauthAccessTokens.teamId, authCode.teamId),
        eq(oauthAccessTokens.revoked, false),
        gte(oauthAccessTokens.createdAt, timeWindowStart.toISOString()),
        // Only include end time filter if we have the auth code creation time
        ...(authCode.createdAt
          ? [lte(oauthAccessTokens.createdAt, timeWindowEnd.toISOString())]
          : []),
      ),
    )
    .returning({
      id: oauthAccessTokens.id,
      token: oauthAccessTokens.token,
    });

  return revokedTokens;
}
