import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import {
  customers,
  documents,
  documentTags,
  inboxAccounts,
  invoiceTemplates,
  tags,
  trackerProjects,
  transactions,
  usersOnTeam,
} from "../schema";

const teamResources = {
  customers,
  documents,
  documentTags,
  invoiceTemplates,
  inboxAccounts,
  tags,
  trackerProjects,
  transactions,
};

export class TenantResourceNotFoundError extends Error {
  constructor() {
    // Missing and foreign IDs deliberately have the same response.
    super("Resource not found");
    this.name = "TenantResourceNotFoundError";
  }
}

function uniqueIds(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id != null))];
}

/**
 * Validate every reference before writing any part of a batch. Call within the
 * mutation's transaction: shared row locks keep ownership stable until commit.
 * Foreign keys alone only establish existence, not membership in the team.
 */
export async function assertTeamOwnership(
  db: DatabaseOrTransaction,
  teamId: string,
  resource: keyof typeof teamResources,
  ids: readonly (string | null | undefined)[],
): Promise<void> {
  const requiredIds = uniqueIds(ids);
  if (requiredIds.length === 0) return;

  const table = teamResources[resource];
  const records = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.teamId, teamId), inArray(table.id, requiredIds)))
    .for("share");

  if (records.length !== requiredIds.length) {
    throw new TenantResourceNotFoundError();
  }
}

export async function assertTeamMembers(
  db: DatabaseOrTransaction,
  teamId: string,
  userIds: readonly (string | null | undefined)[],
): Promise<void> {
  const requiredIds = uniqueIds(userIds);
  if (requiredIds.length === 0) return;

  const members = await db
    .select({ id: usersOnTeam.userId })
    .from(usersOnTeam)
    .where(
      and(
        eq(usersOnTeam.teamId, teamId),
        inArray(usersOnTeam.userId, requiredIds),
      ),
    )
    .for("share");

  if (new Set(members.map((member) => member.id)).size !== requiredIds.length) {
    throw new TenantResourceNotFoundError();
  }
}
