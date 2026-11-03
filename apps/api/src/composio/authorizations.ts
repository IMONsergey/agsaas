import type { DatabaseOrTransaction } from "@midday/db/client";
import { TeamMembershipError } from "@midday/db/errors";
import { appendSecurityAuditEvent } from "@midday/db/queries/security-audit";
import {
  attachTeamConnector,
  listTeamConnectors,
  reserveTeamConnector,
  type TeamConnectorReservation,
} from "@midday/db/queries/team-entitlements";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamOwner,
} from "@midday/db/utils/team-membership";

const primary = (db: DatabaseOrTransaction) =>
  // biome-ignore lint/correctness/useHookAtTopLevel: Drizzle primary routing is not a React hook.
  "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;

/** Commit the current owner's authorization before any external provider IO. */
export async function reserveOwnedTeamConnector(
  db: DatabaseOrTransaction,
  input: { teamId: string; toolkit: string; actorId: string },
) {
  return primary(db).transaction(async (tx) => {
    await lockUserMembership(tx, input.actorId);
    requireTeamOwner(await lockTeamMembership(tx, input.teamId), input.actorId);
    const reservation = await reserveTeamConnector(tx, input);
    if (reservation.created)
      await appendSecurityAuditEvent(tx, {
        teamId: input.teamId,
        actorUserId: input.actorId,
        operation: "integration.authorize",
        targetType: "connector",
        targetId: reservation.id,
        metadata: { provider: "composio", status: "pending" },
      });
    return reservation;
  });
}

/** Completing a delayed provider flow cannot revive a departed/demoted owner's authorization. */
export async function attachOwnedTeamConnector(
  db: DatabaseOrTransaction,
  reservation: TeamConnectorReservation,
  providerAccountId: string,
) {
  if (!reservation.actorId) return false;
  try {
    return await primary(db).transaction(async (tx) => {
      await lockUserMembership(tx, reservation.actorId!);
      requireTeamOwner(
        await lockTeamMembership(tx, reservation.teamId),
        reservation.actorId!,
      );
      const current = (await listTeamConnectors(tx, reservation.teamId)).find(
        (row) => row.id === reservation.id,
      );
      if (
        !current ||
        current.actorId !== reservation.actorId ||
        !["pending", "unknown"].includes(current.status)
      )
        return false;
      await attachTeamConnector(tx, {
        teamId: reservation.teamId,
        id: reservation.id,
        providerAccountId,
      });
      await appendSecurityAuditEvent(tx, {
        teamId: reservation.teamId,
        actorUserId: reservation.actorId,
        operation: "integration.connect",
        targetType: "connector",
        targetId: reservation.id,
        metadata: { provider: "composio", status: "active" },
      });
      return true;
    });
  } catch (error) {
    if (error instanceof TeamMembershipError) return false;
    throw error;
  }
}
