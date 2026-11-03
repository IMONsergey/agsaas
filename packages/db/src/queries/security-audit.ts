import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { securityAuditMetadata } from "../security-audit";

export type SecurityAuditEvent = {
  id: string;
  createdAt: string;
  teamId: string | null;
  actorUserId: string | null;
  operation: string;
  targetType: string;
  targetId: string;
  metadata: ReturnType<typeof securityAuditMetadata>;
};
export async function appendSecurityAuditEvent(
  db: DatabaseOrTransaction,
  input: {
    teamId: string | null;
    actorUserId?: string | null;
    operation: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  },
) {
  if (
    !/^[a-z][a-z0-9_.:-]{1,63}$/.test(input.operation) ||
    !/^[a-z_]{1,32}$/.test(input.targetType) ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.targetId)
  )
    throw new Error("Invalid security audit event");
  await db.execute(sql`INSERT INTO public.security_audit_events(team_id, actor_user_id, operation, target_type, target_id, metadata)
    VALUES (${input.teamId}::uuid, ${input.actorUserId ?? null}::uuid, ${input.operation}, ${input.targetType}, ${input.targetId}, ${JSON.stringify(securityAuditMetadata(input.metadata))}::jsonb)`);
}
export async function listSecurityAuditEvents(
  db: DatabaseOrTransaction,
  input: {
    teamId: string | null;
    actorUserId?: string;
    limit?: number;
    beforeId?: string;
  },
) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  if (input.beforeId && !/^[0-9]{1,24}$/.test(input.beforeId))
    throw new Error("Invalid audit cursor");
  if (!input.teamId && !input.actorUserId)
    throw new Error("Audit scope is required");
  const scope = input.teamId
    ? sql`(team_id = ${input.teamId}::uuid OR (team_id IS NULL AND actor_user_id = ${input.actorUserId ?? null}::uuid))`
    : sql`team_id IS NULL AND actor_user_id = ${input.actorUserId!}::uuid`;
  const cursor = input.beforeId
    ? sql`AND id < ${input.beforeId}::bigint`
    : sql``;
  const result =
    await db.execute<SecurityAuditEvent>(sql`SELECT id::text, created_at AS "createdAt", team_id AS "teamId", actor_user_id AS "actorUserId", operation, target_type AS "targetType", target_id AS "targetId", metadata
    FROM public.security_audit_events WHERE ${scope} ${cursor} ORDER BY id DESC LIMIT ${limit}`);
  return {
    events: result.rows,
    nextCursor: result.rows.length === limit ? result.rows.at(-1)!.id : null,
  };
}
