import { eq, sql } from "drizzle-orm";
import type { TransactionClient } from "../client";
import { TeamMembershipError } from "../errors";
import { teams, users, usersOnTeam } from "../schema";

export type TeamMembership = {
  userId: string;
  role: "owner" | "member" | null;
};

/**
 * Serialize membership acquisition with deletion preparation. The persisted
 * marker, not a long-lived transaction, protects against late Auth completion.
 */
export async function lockUserMembership(
  tx: TransactionClient,
  userId: string,
  options: { allowPendingDeletion?: boolean } = {},
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agsaas:membership:${userId}`}, 0))`,
  );
  if (!options.allowPendingDeletion) {
    const [profile] = await tx
      .select({ deletionStartedAt: users.deletionStartedAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!profile) throw new TeamMembershipError("TEAM_ACCESS_DENIED");
    if (profile.deletionStartedAt) {
      throw new TeamMembershipError("ACCOUNT_DELETION_PENDING");
    }
  }
}

/** All team membership writers use this lock before reading authorization. */
export async function lockTeamMembership(
  tx: TransactionClient,
  teamId: string,
): Promise<TeamMembership[]> {
  const [team] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for("update");

  if (!team) throw new TeamMembershipError("TEAM_ACCESS_DENIED");

  return tx
    .select({ userId: usersOnTeam.userId, role: usersOnTeam.role })
    .from(usersOnTeam)
    .where(eq(usersOnTeam.teamId, teamId));
}

export function requireTeamMember(
  members: readonly TeamMembership[],
  userId: string,
): void {
  if (!members.some((member) => member.userId === userId)) {
    throw new TeamMembershipError("TEAM_ACCESS_DENIED");
  }
}

export function requireTeamOwner(
  members: readonly TeamMembership[],
  userId: string,
): void {
  if (
    !members.some(
      (member) => member.userId === userId && member.role === "owner",
    )
  ) {
    throw new TeamMembershipError("TEAM_OWNER_REQUIRED");
  }
}

export function requireAnotherOwner(
  members: readonly TeamMembership[],
  departingUserId: string,
): void {
  const isOwner = members.some(
    (member) => member.userId === departingUserId && member.role === "owner",
  );
  // Duplicate membership rows for the same user are not a second owner.
  if (
    isOwner &&
    !members.some(
      (member) => member.userId !== departingUserId && member.role === "owner",
    )
  ) {
    throw new TeamMembershipError("LAST_TEAM_OWNER");
  }
}
