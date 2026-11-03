import { encrypt, hash } from "@midday/encryption";
import { and, eq } from "drizzle-orm";
import type { Database, DatabaseOrTransaction } from "../client";
import { apiKeys, users } from "../schema";
import { generateApiKey } from "../utils/api-keys";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamOwner,
} from "../utils/team-membership";
import { TenantResourceNotFoundError } from "../utils/tenant-ownership";
import { appendSecurityAuditEvent } from "./security-audit";

export type ApiKey = {
  id: string;
  name: string;
  userId: string;
  teamId: string;
  createdAt: string;
  scopes: string[] | null;
};

export async function getApiKeyByToken(db: Database, keyHash: string) {
  const [result] = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      userId: apiKeys.userId,
      teamId: apiKeys.teamId,
      createdAt: apiKeys.createdAt,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  return result;
}

type UpsertApiKeyData = {
  id?: string;
  name: string;
  userId: string;
  teamId: string;
  scopes: string[];
};

export async function upsertApiKey(
  db: DatabaseOrTransaction,
  data: UpsertApiKeyData,
) {
  return db.transaction(async (tx) => {
    await lockUserMembership(tx, data.userId);
    requireTeamOwner(await lockTeamMembership(tx, data.teamId), data.userId);
    if (data.id) {
      const [before] = await tx
        .select({ scopes: apiKeys.scopes, name: apiKeys.name })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, data.id), eq(apiKeys.teamId, data.teamId)))
        .for("update");
      if (!before) throw new TenantResourceNotFoundError();
      const [result] = await tx
        .update(apiKeys)
        .set({ name: data.name, scopes: data.scopes })
        .where(and(eq(apiKeys.id, data.id), eq(apiKeys.teamId, data.teamId)))
        .returning({ keyHash: apiKeys.keyHash });
      if (!result) throw new TenantResourceNotFoundError();
      await appendSecurityAuditEvent(tx, {
        teamId: data.teamId,
        actorUserId: data.userId,
        operation: "api_key.update",
        targetType: "api_key",
        targetId: data.id,
        metadata: {
          beforeScopes: before.scopes ?? [],
          afterScopes: data.scopes,
          nameChanged: before.name !== data.name,
        },
      });
      return { key: null, keyHash: result.keyHash };
    }
    const key = generateApiKey();
    const [result] = await tx
      .insert(apiKeys)
      .values({
        keyEncrypted: encrypt(key),
        keyHash: hash(key),
        name: data.name,
        userId: data.userId,
        teamId: data.teamId,
        scopes: data.scopes,
      })
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        createdAt: apiKeys.createdAt,
      });
    if (!result) throw new Error("API key was not saved");
    await appendSecurityAuditEvent(tx, {
      teamId: data.teamId,
      actorUserId: data.userId,
      operation: "api_key.create",
      targetType: "api_key",
      targetId: result.id,
      metadata: { beforeScopes: [], afterScopes: data.scopes },
    });
    return { key, data: result };
  });
}

export async function getApiKeysByTeam(db: Database, teamId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      user: {
        id: users.id,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.teamId, teamId))
    .orderBy(apiKeys.createdAt);
}

type DeleteApiKeyParams = {
  id: string;
  teamId: string;
  actorUserId: string;
};

export async function deleteApiKey(
  db: DatabaseOrTransaction,
  params: DeleteApiKeyParams,
) {
  return db.transaction(async (tx) => {
    await lockUserMembership(tx, params.actorUserId);
    requireTeamOwner(
      await lockTeamMembership(tx, params.teamId),
      params.actorUserId,
    );
    const [result] = await tx
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, params.id), eq(apiKeys.teamId, params.teamId)))
      .returning({ keyHash: apiKeys.keyHash, scopes: apiKeys.scopes });
    if (!result) return undefined;
    await appendSecurityAuditEvent(tx, {
      teamId: params.teamId,
      actorUserId: params.actorUserId,
      operation: "api_key.delete",
      targetType: "api_key",
      targetId: params.id,
      metadata: { beforeScopes: result.scopes ?? [], afterScopes: [] },
    });
    return result.keyHash;
  });
}

export async function updateApiKeyLastUsedAt(db: Database, id: string) {
  return db
    .update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, id));
}
