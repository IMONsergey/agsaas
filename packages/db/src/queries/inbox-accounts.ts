import { and, eq } from "drizzle-orm";
import type { Database, DatabaseWithPrimary } from "../client";
import { inboxAccounts } from "../schema";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamMember,
} from "../utils/team-membership";
import {
  assertNoPendingProviderCleanup,
  retainInboxAccountCleanup,
} from "./resource-cleanups";

export async function getInboxAccounts(db: Database, teamId: string) {
  return db
    .select({
      id: inboxAccounts.id,
      email: inboxAccounts.email,
      provider: inboxAccounts.provider,
      lastAccessed: inboxAccounts.lastAccessed,
      status: inboxAccounts.status,
      errorMessage: inboxAccounts.errorMessage,
    })
    .from(inboxAccounts)
    .where(eq(inboxAccounts.teamId, teamId));
}

type GetInboxAccountByIdParams = {
  id: string;
  teamId: string;
};

export async function getInboxAccountById(
  db: Database,
  params: GetInboxAccountByIdParams,
) {
  const [result] = await db
    .select({
      id: inboxAccounts.id,
      email: inboxAccounts.email,
      provider: inboxAccounts.provider,
      accessToken: inboxAccounts.accessToken,
      refreshToken: inboxAccounts.refreshToken,
      expiryDate: inboxAccounts.expiryDate,
      lastAccessed: inboxAccounts.lastAccessed,
    })
    .from(inboxAccounts)
    .where(
      and(
        eq(inboxAccounts.id, params.id),
        eq(inboxAccounts.teamId, params.teamId),
      ),
    );

  return result;
}

type DeleteInboxAccountParams = {
  actorUserId?: string;
  id: string;
  teamId: string;
};

export async function deleteInboxAccount(
  db: Database,
  params: DeleteInboxAccountParams,
) {
  return db.transaction(async (tx) => {
    if (params.actorUserId) {
      await lockUserMembership(tx, params.actorUserId);
      requireTeamMember(
        await lockTeamMembership(tx, params.teamId),
        params.actorUserId,
      );
    }
    const [account] = await tx
      .select()
      .from(inboxAccounts)
      .where(
        and(
          eq(inboxAccounts.id, params.id),
          eq(inboxAccounts.teamId, params.teamId),
        ),
      )
      .for("update");
    if (!account?.teamId) return undefined;
    const cleanup = await retainInboxAccountCleanup(tx, {
      ...account,
      teamId: account.teamId,
      actorUserId: params.actorUserId,
    });
    await tx
      .delete(inboxAccounts)
      .where(
        and(
          eq(inboxAccounts.id, params.id),
          eq(inboxAccounts.teamId, params.teamId),
        ),
      );
    return {
      id: account.id,
      scheduleId: account.scheduleId,
      cleanupPending: cleanup.status !== "completed",
      cleanupId: cleanup.id,
    };
  });
}

export type UpdateInboxAccountParams = {
  id: string;
  refreshToken?: string;
  accessToken?: string;
  expiryDate?: string;
  scheduleId?: string;
  lastAccessed?: string;
  status?: "connected" | "disconnected";
  errorMessage?: string | null;
};

export async function updateInboxAccount(
  db: Database,
  params: UpdateInboxAccountParams,
) {
  return db
    .update(inboxAccounts)
    .set({
      refreshToken: params.refreshToken,
      accessToken: params.accessToken,
      expiryDate: params.expiryDate,
      scheduleId: params.scheduleId,
      lastAccessed: params.lastAccessed,
      status: params.status as any,
      errorMessage: params.errorMessage,
    })
    .where(eq(inboxAccounts.id, params.id));
}

export type UpsertInboxAccountParams = {
  actorUserId: string;
  teamId: string;
  provider: string;
  accessToken: string;
  refreshToken: string;
  email: string;
  lastAccessed: string;
  externalId: string;
  expiryDate: string;
};

export async function upsertInboxAccount(
  db: Database,
  params: UpsertInboxAccountParams,
) {
  const primaryOnly = (db as DatabaseWithPrimary).usePrimaryOnly;
  const authDb = primaryOnly ? primaryOnly.call(db) : db;
  return authDb.transaction(async (tx) => {
    // Provider HTTP calls have already finished. Recheck and serialize this
    // final write with membership removal/deletion before storing credentials.
    await lockUserMembership(tx, params.actorUserId);
    const members = await lockTeamMembership(tx, params.teamId);
    requireTeamMember(members, params.actorUserId);
    await assertNoPendingProviderCleanup(
      tx,
      params.teamId,
      params.provider,
      params.externalId,
    );

    const [result] = await tx
      .insert(inboxAccounts)
      .values({
        teamId: params.teamId,
        provider: params.provider as any,
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        email: params.email,
        lastAccessed: params.lastAccessed,
        externalId: params.externalId,
        expiryDate: params.expiryDate,
      })
      .onConflictDoUpdate({
        target: inboxAccounts.externalId,
        set: {
          accessToken: params.accessToken,
          refreshToken: params.refreshToken,
          lastAccessed: params.lastAccessed,
          expiryDate: params.expiryDate,
          status: "connected",
          errorMessage: null,
        },
        setWhere: and(
          eq(inboxAccounts.teamId, params.teamId),
          eq(inboxAccounts.provider, params.provider as "gmail" | "outlook"),
        ),
      })
      .returning({
        id: inboxAccounts.id,
        provider: inboxAccounts.provider,
        external_id: inboxAccounts.externalId,
      });

    return result;
  });
}

type GetInboxAccountInfoParams = {
  id: string;
};

export async function getInboxAccountInfo(
  db: Database,
  params: GetInboxAccountInfoParams,
) {
  // Background jobs must observe disconnect/delete immediately, not a replica.
  const primaryOnly = (db as DatabaseWithPrimary).usePrimaryOnly;
  const readDb = primaryOnly ? primaryOnly.call(db) : db;
  const [result] = await readDb
    .select({
      id: inboxAccounts.id,
      provider: inboxAccounts.provider,
      teamId: inboxAccounts.teamId,
      lastAccessed: inboxAccounts.lastAccessed,
      status: inboxAccounts.status,
    })
    .from(inboxAccounts)
    .where(eq(inboxAccounts.id, params.id))
    .limit(1);

  return result;
}
