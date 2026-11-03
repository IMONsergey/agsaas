import type { Database, DatabaseOrTransaction } from "../client";
import { revokeAuthSessions } from "./auth-sessions";
import { appendSecurityAuditEvent } from "./security-audit";

/** Revocation and its security receipt either both commit or both roll back. */
export function revokeAuthSessionsWithAudit(
  db: DatabaseOrTransaction,
  input: { userId: string; currentSessionId: string; scope: "all" | "others" },
) {
  const source = db as Database & {
    usePrimaryOnly?: () => Database;
    $primary?: Database;
  };
  const primary = source.usePrimaryOnly?.() ?? source.$primary ?? db;
  return primary.transaction(async (tx) => {
    const result = await revokeAuthSessions(
      tx,
      input.userId,
      input.currentSessionId,
      input.scope,
    );
    await appendSecurityAuditEvent(tx, {
      teamId: null,
      actorUserId: input.userId,
      operation: "session.revoke",
      targetType: "user",
      targetId: input.userId,
      metadata: { count: result.revoked, scope: input.scope },
    });
    return result;
  });
}
