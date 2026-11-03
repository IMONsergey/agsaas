import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { teams, users, usersOnTeam } from "../schema";
import {
  lockTeamMembership,
  lockUserMembership,
  requireAnotherOwner,
  requireTeamMember,
  requireTeamOwner,
} from "../utils/team-membership";
import { retainTeamBankConnectionCleanups } from "./bank-connection-cleanups";
import {
  retainTeamResourceCleanups,
  retainUserResourceCleanups,
} from "./resource-cleanups";

export const getUserById = async (
  db: Database,
  id: string,
  context?: { teamId: string | null },
) => {
  // Scoped credentials must not inherit a different active profile team.
  // Undefined preserves the dashboard/profile lookup; explicit null selects
  // no team for an authenticated user still completing onboarding.
  const selectedTeamId = context
    ? sql<string | null>`${context.teamId}::uuid`
    : users.teamId;
  const [result] = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      avatarUrl: users.avatarUrl,
      locale: users.locale,
      timeFormat: users.timeFormat,
      dateFormat: users.dateFormat,
      weekStartsOnMonday: users.weekStartsOnMonday,
      timezone: users.timezone,
      timezoneAutoSync: users.timezoneAutoSync,
      teamId: selectedTeamId,
      deletionStartedAt: users.deletionStartedAt,
      team: {
        id: teams.id,
        name: teams.name,
        logoUrl: teams.logoUrl,
        email: teams.email,
        plan: teams.plan,
        subscriptionStatus: teams.subscriptionStatus,
        inboxId: teams.inboxId,
        createdAt: teams.createdAt,
        countryCode: teams.countryCode,
        canceledAt: teams.canceledAt,
        baseCurrency: teams.baseCurrency,
      },
    })
    .from(users)
    .leftJoin(teams, eq(teams.id, selectedTeamId))
    .where(eq(users.id, id));

  return result;
};

export type UpdateUserParams = {
  id: string;
  fullName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
  timeFormat?: number | null;
  dateFormat?: string | null;
  weekStartsOnMonday?: boolean | null;
  timezone?: string | null;
  timezoneAutoSync?: boolean | null;
};

export const updateUser = async (db: Database, data: UpdateUserParams) => {
  const { id, ...updateData } = data;

  const [result] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      avatarUrl: users.avatarUrl,
      locale: users.locale,
      timeFormat: users.timeFormat,
      dateFormat: users.dateFormat,
      weekStartsOnMonday: users.weekStartsOnMonday,
      timezone: users.timezone,
      timezoneAutoSync: users.timezoneAutoSync,
      teamId: users.teamId,
    });

  return result;
};

/**
 * Switch a user's active team. Validates membership in usersOnTeam
 * to prevent unauthorized team access.
 */
export const switchUserTeam = async (
  db: Database,
  params: { userId: string; teamId: string },
) => {
  const { userId, teamId } = params;

  return db.transaction(async (db) => {
    await lockUserMembership(db, userId);
    const members = await lockTeamMembership(db, teamId);
    requireTeamMember(members, userId);

    // Get the user's current teamId so we can invalidate its cache entry
    const currentUser = await db.query.users.findFirst({
      columns: { teamId: true },
      where: eq(users.id, userId),
    });

    const [result] = await db
      .update(users)
      .set({ teamId })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        teamId: users.teamId,
      });

    return { ...result, previousTeamId: currentUser?.teamId ?? null };
  });
};

export const getUserTeamId = async (db: Database, userId: string) => {
  const result = await db.query.users.findFirst({
    columns: { teamId: true },
    where: eq(users.id, userId),
  });

  return result?.teamId || null;
};

/**
 * Retryable account deletion, not a distributed transaction with Auth.
 * Local preparation and a durable deletion marker commit first. A definite
 * Auth rejection leaves a profile for retry; an ambiguous transport failure
 * must never reopen membership acquisition. Auth is bounded by the API caller.
 */
export const deleteUser = async (
  db: Database,
  id: string,
  deleteAuthUser: () => Promise<void>,
) => {
  await db.transaction(async (tx) => {
    await lockUserMembership(tx, id, { allowPendingDeletion: true });
    const memberships = await tx
      .select({ teamId: usersOnTeam.teamId })
      .from(usersOnTeam)
      .where(eq(usersOnTeam.userId, id));
    const teamIds = [...new Set(memberships.map((row) => row.teamId))].sort();
    const soloTeams: string[] = [];

    // Lock in a stable order and validate ALL teams before changing anything.
    for (const teamId of teamIds) {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, teamId))
        .for("update");
      // Another authorized deletion may have completed before our lock.
      if (!team) continue;
      const members = await lockTeamMembership(tx, teamId);
      if (!members.some((member) => member.userId === id)) continue;
      if (new Set(members.map((member) => member.userId)).size === 1) {
        requireTeamOwner(members, id);
        soloTeams.push(teamId);
      } else {
        requireAnotherOwner(members, id);
      }
    }

    await retainUserResourceCleanups(tx, id);
    for (const teamId of soloTeams) {
      await retainTeamBankConnectionCleanups(tx, teamId);
      await retainTeamResourceCleanups(tx, teamId, id);
      await tx.delete(teams).where(eq(teams.id, teamId));
    }
    await tx.delete(usersOnTeam).where(eq(usersOnTeam.userId, id));
    await tx
      .update(users)
      .set({
        teamId: null,
        deletionStartedAt: sql`COALESCE(${users.deletionStartedAt}, CURRENT_TIMESTAMP)`,
      })
      .where(eq(users.id, id));
  });

  // No DB connection or row/advisory lock is held across Auth. Preparation
  // stays committed on failure; retry cannot restore membership accidentally.
  await deleteAuthUser();
  // Auth cascades the profile on the matched Supabase stack. This idempotent
  // cleanup also supports older deployments without that foreign key.
  await db.delete(users).where(eq(users.id, id));
  return { id, cleanupPending: true };
};
