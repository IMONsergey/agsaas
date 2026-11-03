import {isSessionActive} from "./auth-session";
import { withAuth } from "@api/rest/middleware/auth";
import type { DatabaseWithPrimary } from "@midday/db/client";
import { getUserById, hasTeamAccess } from "@midday/db/queries";
import { verifyFileKey } from "@midday/encryption";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { MfaPolicyError, requireSessionMfa } from "./mfa";
import type { Scope } from "./scopes";

export type FileAccess = { userId: string; teamId: string };

/**
 * Dashboard img/download URLs use a short-lived, user-bound key. API/OAuth
 * clients use their original Bearer credential and the route's read scope.
 * Neither mode may inherit the account's unrelated active profile team.
 */
export async function requireFileAccess(
  c: Context,
  requiredScope: Extract<Scope, "documents.read" | "invoices.read">,
): Promise<FileAccess> {
  const fk = c.req.query("fk");
  if (!fk) {
    await withAuth(c, async () => {});
    const teamId = c.get("teamId");
    const session = c.get("session");
    const scopes: Scope[] = c.get("scopes") ?? [];
    if (
      !teamId ||
      !session?.user?.id ||
      c.get("user")?.deletionStartedAt ||
      !scopes.includes(requiredScope)
    ) {
      throw new HTTPException(403, {
        message: "No permission to access this file.",
      });
    }
    return { userId: session.user.id, teamId };
  }

  const identity = await verifyFileKey(fk);
  if (!identity) {
    throw new HTTPException(401, { message: "Invalid or expired file key." });
  }

  const db = c.get("db") as DatabaseWithPrimary;
  const authDb = db.usePrimaryOnly ? db.usePrimaryOnly.call(db) : db;
  const user = await getUserById(authDb, identity.userId);
  if (
    !user ||
    user.deletionStartedAt ||
    !(await isSessionActive(authDb,identity.userId,identity.sessionId)) ||
    !(await hasTeamAccess(authDb, identity.teamId, identity.userId))
  ) {
    throw new HTTPException(401, { message: "Invalid or expired file key." });
  }

  try {
    await requireSessionMfa({
      user: { id: identity.userId },
      aal: identity.aal,
    });
  } catch (error) {
    if (error instanceof MfaPolicyError) {
      throw new HTTPException(error.reason === "required" ? 403 : 503, {
        message: error.message,
      });
    }
    throw error;
  }
  return { userId: identity.userId, teamId: identity.teamId };
}
