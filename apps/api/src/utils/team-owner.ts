import type { Database } from "@midday/db/client";
import { getTeamMemberRole } from "@midday/db/queries";

export class TeamOwnerRequiredError extends Error {
  constructor() { super("Only a team owner can manage this setting"); this.name = "TeamOwnerRequiredError"; }
}
/** Authorization reads use primary storage so demotions/revocations apply now. */
export async function requireTeamOwner(db: Database, teamId: string | undefined, userId: string) {
  if (!teamId) throw new TeamOwnerRequiredError();
  const primary = db.usePrimaryOnly ? db.usePrimaryOnly() : db;
  if (await getTeamMemberRole(primary, teamId, userId) !== "owner") throw new TeamOwnerRequiredError();
}
