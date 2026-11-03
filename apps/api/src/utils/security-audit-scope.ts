import {
  requireTeamOwner,
  TeamOwnerRequiredError,
} from "@api/utils/team-owner";
import type { Database } from "@midday/db/client";

/** Nonowners retain access to their own account events, never the team's journal. */
export async function resolveSecurityAuditScope(
  db: Database,
  input: { teamId?: string | null; actorUserId: string },
) {
  if (input.teamId) {
    try {
      await requireTeamOwner(db, input.teamId, input.actorUserId);
      return { teamId: input.teamId, actorUserId: input.actorUserId };
    } catch (error) {
      if (!(error instanceof TeamOwnerRequiredError)) throw error;
    }
  }
  return { teamId: null, actorUserId: input.actorUserId };
}
