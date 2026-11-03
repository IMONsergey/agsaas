import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database, DatabaseWithPrimary, TransactionClient } from "../client";
import { lockTeamMembership, lockUserMembership, requireTeamMember } from "../utils/team-membership";

export type AssistantAction = "invoices_send" | "invoices_delete";
export type AssistantActionActor = { userId: string; teamId: string; sessionId: string };
export type AssistantActionPreview = {
  invoiceId: string;
  revision: string;
  recipient: string | null;
  bcc: string[];
  replyTo?: string;
  customerName: string | null;
  amount: number;
  currency: string;
  invoiceNumber: string | null;
  status: string;
};
export type AssistantActionReceipt = {
  invoiceId: string;
  action: AssistantAction;
  outcome: "queued" | "deleted" | "stale";
  operationId?: string;
};
export type AssistantActionApproval = {
  id: string;
  toolName: AssistantAction;
  preview: AssistantActionPreview;
  expiresAt: string;
  status: "pending" | "succeeded" | "rejected" | "expired" | "stale";
  result: AssistantActionReceipt | null;
};
export class AssistantApprovalError extends Error {
  constructor(public readonly reason: "not_found" | "limit" | "invalid") {
    super(reason === "limit" ? "Review existing pending actions before requesting another." : "This action approval is no longer available.");
    this.name = "AssistantApprovalError";
  }
}
function primary(db: Database) { return (db as DatabaseWithPrimary).usePrimaryOnly?.() ?? db; }
async function lockActor(tx: TransactionClient, actor: AssistantActionActor) {
  await lockUserMembership(tx, actor.userId);
  requireTeamMember(await lockTeamMembership(tx, actor.teamId), actor.userId);
  const session = await tx.execute<{ active: boolean }>(sql`SELECT private.auth_session_active(${actor.userId}::uuid, ${actor.sessionId}::uuid) AS active`);
  if (session.rows[0]?.active !== true) throw new AssistantApprovalError("invalid");
}
const fields = sql`id, tool_name AS "toolName", preview, expires_at AS "expiresAt", status, result`;
function validActor(actor: AssistantActionActor) {
  if (![actor.userId, actor.teamId, actor.sessionId].every(id => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))) throw new AssistantApprovalError("invalid");
}

/** This creates a proposal only. No invoice mutation or provider call occurs. */
export async function createAssistantActionApproval(db: Database, actor: AssistantActionActor, toolName: AssistantAction, preview: AssistantActionPreview) {
  validActor(actor);
  const serialized = JSON.stringify(preview);
  if (serialized.length > 16_384 || !Number.isFinite(preview.amount) || !preview.revision || !preview.invoiceId || preview.bcc.length > 20) throw new AssistantApprovalError("invalid");
  const fingerprint = createHash("sha256").update(`${toolName}\n${serialized}`).digest("hex");
  return primary(db).transaction(async tx => {
    await lockActor(tx, actor);
    // The user membership lock serializes proposals and keeps the cap exact.
    await tx.execute(sql`UPDATE public.assistant_action_approvals SET status = 'expired'
      WHERE user_id = ${actor.userId} AND status = 'pending' AND expires_at <= now()`);
    await tx.execute(sql`DELETE FROM public.assistant_action_approvals WHERE user_id = ${actor.userId} AND expires_at < now() - interval '7 days'`);
    const existing = await tx.execute<AssistantActionApproval>(sql`SELECT ${fields} FROM public.assistant_action_approvals
      WHERE user_id = ${actor.userId} AND team_id = ${actor.teamId} AND session_id = ${actor.sessionId}
        AND fingerprint = ${fingerprint} AND status = 'pending' AND expires_at > now() LIMIT 1`);
    if (existing.rows[0]) return existing.rows[0];
    const count = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM public.assistant_action_approvals
      WHERE user_id = ${actor.userId} AND team_id = ${actor.teamId} AND status = 'pending' AND expires_at > now()`);
    if (Number(count.rows[0]!.count) >= 10) throw new AssistantApprovalError("limit");
    const inserted = await tx.execute<AssistantActionApproval>(sql`INSERT INTO public.assistant_action_approvals
      (user_id, team_id, session_id, tool_name, fingerprint, preview, expires_at)
      VALUES (${actor.userId}, ${actor.teamId}, ${actor.sessionId}, ${toolName}, ${fingerprint}, ${serialized}::jsonb, now() + interval '10 minutes')
      RETURNING ${fields}`);
    return inserted.rows[0]!;
  });
}

export async function listAssistantActionApprovals(db: Database, actor: AssistantActionActor) {
  validActor(actor);
  const result = await primary(db).execute<AssistantActionApproval>(sql`SELECT ${fields} FROM public.assistant_action_approvals
    WHERE user_id = ${actor.userId} AND team_id = ${actor.teamId} AND session_id = ${actor.sessionId}
      AND status = 'pending' AND expires_at > now()
      AND private.auth_session_active(${actor.userId}::uuid, ${actor.sessionId}::uuid)
      AND EXISTS (SELECT 1 FROM public.users_on_team WHERE user_id = ${actor.userId} AND team_id = ${actor.teamId})
      ORDER BY created_at LIMIT 10`);
  return result.rows;
}

/**
 * Only the separately authenticated UI endpoint calls this function. The intent
 * row and invoice command share one outer transaction. A retry of a successful
 * approval returns the saved receipt without executing the command again.
 */
export async function resolveAssistantActionApproval(
  db: Database,
  actor: AssistantActionActor,
  id: string,
  decision: "approve" | "reject",
  execute: (tx: TransactionClient, proposal: AssistantActionApproval) => Promise<AssistantActionReceipt>,
) {
  validActor(actor);
  return primary(db).transaction(async tx => {
    await lockActor(tx, actor);
    const selected = await tx.execute<AssistantActionApproval & { live: boolean }>(sql`SELECT ${fields}, expires_at > now() AS live FROM public.assistant_action_approvals
      WHERE id = ${id} AND user_id = ${actor.userId} AND team_id = ${actor.teamId} AND session_id = ${actor.sessionId} FOR UPDATE`);
    const proposal = selected.rows[0];
    if (!proposal) throw new AssistantApprovalError("not_found");
    if (proposal.status !== "pending") return proposal;
    if (!proposal.live || decision === "reject") {
      const status = proposal.live ? "rejected" : "expired";
      await tx.execute(sql`UPDATE public.assistant_action_approvals SET status = ${status}, completed_at = now() WHERE id = ${id}`);
      return { ...proposal, status: status as "rejected" | "expired" };
    }
    const result = await execute(tx, proposal);
    const status = result.outcome === "stale" ? "stale" : "succeeded";
    await tx.execute(sql`UPDATE public.assistant_action_approvals SET status = ${status}, result = ${JSON.stringify(result)}::jsonb, completed_at = now() WHERE id = ${id}`);
    return { ...proposal, status: status as "stale" | "succeeded", result };
  });
}
