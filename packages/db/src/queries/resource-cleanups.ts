import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@midday/encryption";
import { sql } from "drizzle-orm";
import {
  type CleanupStatus,
  type CleanupTarget,
  cleanupDigest,
  cleanupObjectPath,
  validateCleanupTarget,
} from "../cleanup";
import type { DatabaseOrTransaction, TransactionClient } from "../client";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamOwner,
} from "../utils/team-membership";
import { lockInboxDeletionScope } from "./inbox-deletion-receipts";
import { appendSecurityAuditEvent } from "./security-audit";
import { releaseTeamConnector } from "./team-entitlements";

export type ResourceCleanup = {
  id: string;
  kind: CleanupTarget["kind"];
  teamId: string | null;
  actorUserId: string | null;
  targetId: string;
  provider: string | null;
  status: CleanupStatus;
  encryptedPayload: string | null;
  attempts: number;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchToken: string | null;
};
const columns = sql`id, kind, team_id AS "teamId", actor_user_id AS "actorUserId", target_id AS "targetId", provider, status, encrypted_payload AS "encryptedPayload", attempts, reason, created_at AS "createdAt", updated_at AS "updatedAt", dispatch_token AS "dispatchToken"`;
const primary = (db: DatabaseOrTransaction) =>
  // biome-ignore lint/correctness/useHookAtTopLevel: Drizzle primary routing is not a React hook.
  "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;

/** Retain before deleting the source, in the same transaction. No FK may erase it. */
export async function retainResourceCleanup(
  tx: TransactionClient,
  target: CleanupTarget,
  initial?: { status: "manual_required"; reason: string },
) {
  validateCleanupTarget(target);
  const serialized = JSON.stringify(target);
  if (Buffer.byteLength(serialized) > 65536)
    throw new Error("Cleanup retention exceeds its limit");
  const id = randomUUID();
  const uniqueKey = cleanupDigest(
    [
      target.kind,
      target.teamId,
      target.actorUserId,
      target.targetId,
      target.provider,
    ].join(":"),
  );
  const grantKey =
    target.kind === "provider" && target.data.externalId
      ? cleanupDigest(`${target.provider}:${target.data.externalId}`)
      : null;
  if (grantKey)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${grantKey}, 95000))`,
    );
  const retained = await tx.execute<{
    id: string;
    status: CleanupStatus;
  }>(sql`INSERT INTO public.resource_cleanups(id, kind, team_id, actor_user_id, target_id, provider, status, reason, encrypted_payload, unique_key, grant_key)
    VALUES (${id}::uuid, ${target.kind}, ${target.teamId}::uuid, ${target.actorUserId}::uuid, ${target.targetId}, ${target.provider}, ${initial?.status ?? "pending"}, ${initial?.reason ?? null}, ${encrypt(serialized)}, ${uniqueKey}, ${grantKey})
    ON CONFLICT (unique_key) WHERE status <> 'completed' DO UPDATE SET unique_key = EXCLUDED.unique_key RETURNING id, status`);
  const row = retained.rows[0];
  if (!row) throw new Error("Cleanup intent was not retained");
  await appendSecurityAuditEvent(tx, {
    teamId: target.teamId,
    actorUserId: target.actorUserId,
    operation: "cleanup.request",
    targetType: "cleanup",
    targetId: row.id,
    metadata: {
      provider: target.provider,
      status: row.status,
      source: target.kind,
    },
  });
  return row;
}

export function openResourceCleanup(row: ResourceCleanup): CleanupTarget {
  try {
    const target: unknown = JSON.parse(decrypt(row.encryptedPayload!));
    validateCleanupTarget(target);
    if (
      target.kind !== row.kind ||
      target.teamId !== row.teamId ||
      target.actorUserId !== row.actorUserId ||
      target.targetId !== row.targetId ||
      target.provider !== row.provider
    )
      throw new Error("Unbound cleanup");
    return target;
  } catch {
    throw new Error("Cleanup credentials are unavailable");
  }
}

export async function assertNoPendingProviderCleanup(
  tx: TransactionClient,
  teamId: string,
  provider: string,
  externalId?: string,
) {
  const grantKey = externalId
    ? cleanupDigest(`${provider}:${externalId}`)
    : null;
  if (grantKey)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${grantKey}, 95000))`,
    );
  const result =
    await tx.execute(sql`SELECT id FROM public.resource_cleanups WHERE kind = 'provider' AND provider = ${provider} AND status <> 'completed'
    AND (team_id = ${teamId}::uuid OR (${grantKey}::text IS NOT NULL AND grant_key = ${grantKey})) LIMIT 1`);
  if (result.rows.length)
    throw new Error(
      "Finish the previous provider disconnection before reconnecting",
    );
}

export async function retainAppCleanup(
  tx: TransactionClient,
  input: {
    id: string;
    teamId: string;
    appId: string;
    config: unknown;
    actorUserId?: string | null;
  },
) {
  // Bot identities contain no per-user OAuth grant; unlinking their local routing is sufficient.
  if (["telegram", "whatsapp"].includes(input.appId)) return null;
  const c =
    input.config && typeof input.config === "object"
      ? (input.config as Record<string, unknown>)
      : {};
  const s = (key: string) =>
    typeof c[key] === "string" ? (c[key] as string) : "";
  const data = {
    accessToken: s("accessToken") || s("access_token"),
    refreshToken: s("refreshToken"),
    externalId: s("tenantId") || s("realmId") || s("companyId") || s("team_id"),
  };
  const supported = ["xero", "quickbooks", "slack"].includes(input.appId);
  return retainResourceCleanup(
    tx,
    {
      version: 1,
      kind: "provider",
      teamId: input.teamId,
      actorUserId: input.actorUserId ?? null,
      targetId: input.id,
      provider: input.appId,
      data,
    },
    supported
      ? undefined
      : { status: "manual_required", reason: "provider_console_required" },
  );
}

export async function retainInboxAccountCleanup(
  tx: TransactionClient,
  input: {
    id: string;
    teamId: string;
    provider: string;
    externalId: string;
    accessToken: string | null;
    refreshToken: string | null;
    actorUserId?: string | null;
  },
) {
  // Inbox token columns are already encrypted; wrap only the minimal decrypted target.
  const data = {
    externalId: input.externalId,
    accessToken: input.accessToken ? decrypt(input.accessToken) : "",
    refreshToken: input.refreshToken ? decrypt(input.refreshToken) : "",
  };
  return retainResourceCleanup(
    tx,
    {
      version: 1,
      kind: "provider",
      teamId: input.teamId,
      actorUserId: input.actorUserId ?? null,
      targetId: input.id,
      provider: input.provider,
      data,
    },
    input.provider === "gmail"
      ? undefined
      : { status: "manual_required", reason: "provider_console_required" },
  );
}

export async function retainFileCleanup(
  tx: TransactionClient,
  input: {
    teamId: string;
    path: string | readonly string[];
    actorUserId?: string;
  },
) {
  const path = cleanupObjectPath(input.teamId, input.path);
  const pathHash = cleanupDigest(`vault:${path}`);
  await lockInboxDeletionScope(tx, {
    teamId: input.teamId,
    filePath: path.split("/"),
  });
  await tx.execute(
    sql`INSERT INTO public.storage_deletion_tombstones(team_id, object_hash) VALUES (${input.teamId}::uuid, ${pathHash}) ON CONFLICT DO NOTHING`,
  );
  return retainResourceCleanup(tx, {
    version: 1,
    kind: "storage-object",
    teamId: input.teamId,
    actorUserId: input.actorUserId ?? null,
    targetId: pathHash,
    provider: null,
    data: { path },
  });
}

export async function requestStripeDisconnect(
  db: DatabaseOrTransaction,
  input: { teamId: string; actorUserId: string },
) {
  return primary(db).transaction(async (tx) => {
    await lockUserMembership(tx, input.actorUserId);
    requireTeamOwner(
      await lockTeamMembership(tx, input.teamId),
      input.actorUserId,
    );
    const found = await tx.execute<{ account: string | null }>(
      sql`SELECT stripe_account_id AS account FROM public.teams WHERE id = ${input.teamId}::uuid FOR UPDATE`,
    );
    const account = found.rows[0]?.account;
    let cleanup: { id: string; status: CleanupStatus } | null = null;
    if (account)
      cleanup = await retainResourceCleanup(tx, {
        version: 1,
        kind: "provider",
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        targetId: account,
        provider: "stripe",
        data: { externalId: account },
      });
    await tx.execute(
      sql`UPDATE public.teams SET stripe_account_id = NULL, stripe_connect_status = NULL WHERE id = ${input.teamId}::uuid`,
    );
    await appendSecurityAuditEvent(tx, {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      operation: "integration.disconnect",
      targetType: "integration",
      targetId: "stripe",
      metadata: {
        provider: "stripe",
        connected: false,
        status: cleanup?.status ?? "completed",
      },
    });
    return {
      success: true,
      cleanupPending: !!cleanup && cleanup.status !== "completed",
      cleanupId: cleanup?.id ?? null,
    };
  });
}

export async function retainTeamResourceCleanups(
  tx: TransactionClient,
  teamId: string,
  actorUserId: string,
) {
  let count = 0;
  const installed = await tx.execute<{
    id: string;
    appId: string;
    config: unknown;
  }>(
    sql`SELECT id, app_id AS "appId", config FROM public.apps WHERE team_id = ${teamId}::uuid ORDER BY id FOR UPDATE`,
  );
  for (const app of installed.rows)
    if (await retainAppCleanup(tx, { ...app, teamId, actorUserId })) count++;
  const accounts = await tx.execute<{
    id: string;
    provider: string;
    externalId: string;
    accessToken: string | null;
    refreshToken: string | null;
  }>(
    sql`SELECT id, provider, external_id AS "externalId", access_token AS "accessToken", refresh_token AS "refreshToken" FROM public.inbox_accounts WHERE team_id = ${teamId}::uuid ORDER BY id FOR UPDATE`,
  );
  for (const account of accounts.rows) {
    await retainInboxAccountCleanup(tx, { ...account, teamId, actorUserId });
    count++;
  }
  const team = await tx.execute<{
    stripeAccountId: string | null;
    customerId: string | null;
  }>(
    sql`SELECT stripe_account_id AS "stripeAccountId", billing_subscription_id AS "customerId" FROM public.teams WHERE id = ${teamId}::uuid`,
  );
  if (team.rows[0]?.stripeAccountId) {
    await retainResourceCleanup(tx, {
      version: 1,
      kind: "provider",
      teamId,
      actorUserId,
      targetId: team.rows[0].stripeAccountId,
      provider: "stripe",
      data: { externalId: team.rows[0].stripeAccountId },
    });
    count++;
  }
  if (team.rows[0]?.customerId) {
    await retainResourceCleanup(
      tx,
      {
        version: 1,
        kind: "billing",
        teamId,
        actorUserId,
        targetId: teamId,
        provider: "billing",
        data: { subscriptionId: team.rows[0].customerId },
      },
      { status: "manual_required", reason: "billing_retention_review" },
    );
    count++;
  }
  for (const kind of ["storage-team", "retention"] as const) {
    await retainResourceCleanup(
      tx,
      {
        version: 1,
        kind,
        teamId,
        actorUserId,
        targetId: teamId,
        provider: null,
        data: {},
      },
      kind === "retention"
        ? {
            status: "manual_required",
            reason: "backup_and_legacy_asset_review",
          }
        : undefined,
    );
    count++;
  }
  // Preserve Composio identity even for a pending/ambiguous authorization whose account ID is not known yet.
  const connectors = await tx.execute<{
    id: string;
    toolkit: string;
    entityId: string;
    providerAccountId: string | null;
  }>(
    sql`SELECT id, toolkit, entity_id AS "entityId", provider_account_id AS "providerAccountId" FROM public.team_connector_reservations WHERE team_id = ${teamId}::uuid AND status <> 'released' ORDER BY id FOR UPDATE`,
  );
  for (const connector of connectors.rows) {
    await retainResourceCleanup(
      tx,
      {
        version: 1,
        kind: "provider",
        teamId,
        actorUserId,
        targetId: connector.id,
        provider: "composio",
        data: {
          externalId: connector.providerAccountId ?? "",
          entityId: connector.entityId,
          toolkit: connector.toolkit,
          reservationId: connector.id,
        },
      },
      !connector.providerAccountId
        ? {
            status: "manual_required",
            reason: "provider_connection_reconciliation",
          }
        : undefined,
    );
    count++;
  }
  // Explicit PII purge before ON DELETE SET NULL loses the association.
  await tx.execute(
    sql`SELECT private.purge_support_subject(${teamId}::uuid, NULL)`,
  );
  await appendSecurityAuditEvent(tx, {
    teamId,
    actorUserId,
    operation: "team.delete",
    targetType: "team",
    targetId: teamId,
    metadata: { status: "pending", count },
  });
  return count;
}

export async function retainUserResourceCleanups(
  tx: TransactionClient,
  userId: string,
) {
  const user = await tx.execute<{ email: string | null }>(
    sql`SELECT email FROM public.users WHERE id = ${userId}::uuid`,
  );
  for (const kind of ["storage-user", "auth-user", "retention"] as const)
    await retainResourceCleanup(
      tx,
      {
        version: 1,
        kind,
        teamId: null,
        actorUserId: userId,
        targetId: userId,
        provider: null,
        data: {},
      },
      kind === "retention"
        ? {
            status: "manual_required",
            reason: "backup_and_legacy_asset_review",
          }
        : undefined,
    );
  if (user.rows[0]?.email && process.env.RESEND_AUDIENCE_ID?.trim())
    await retainResourceCleanup(tx, {
      version: 1,
      kind: "marketing",
      teamId: null,
      actorUserId: userId,
      targetId: userId,
      provider: "resend",
      data: {
        email: user.rows[0].email,
        audienceId: process.env.RESEND_AUDIENCE_ID.trim(),
      },
    });
  await tx.execute(
    sql`SELECT private.purge_support_subject(NULL, ${userId}::uuid)`,
  );
  await appendSecurityAuditEvent(tx, {
    teamId: null,
    actorUserId: userId,
    operation: "user.delete",
    targetType: "user",
    targetId: userId,
    metadata: { status: "pending" },
  });
}

/** Fresh primary state, one lease across worker restarts. Queues carry no credentials. */
export async function claimResourceCleanups(
  db: DatabaseOrTransaction,
  limit = 5,
  teamId?: string,
) {
  return primary(db).transaction(async (tx) => {
    const scope = teamId ? sql`AND team_id = ${teamId}::uuid` : sql``;
    // Provider interruption is uncertain: preserve credentials and require reconciliation.
    await tx.execute(
      sql`UPDATE public.resource_cleanups SET status = CASE WHEN kind = 'provider' THEN 'unknown' ELSE 'pending' END, reason = 'dispatch_interrupted', dispatch_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE status = 'processing' AND lease_expires_at <= now() ${scope}`,
    );
    const result =
      await tx.execute<ResourceCleanup>(sql`WITH due AS (SELECT id FROM public.resource_cleanups WHERE status = 'pending' AND next_attempt_at <= now() ${scope} ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT ${Math.min(Math.max(limit, 1), 10)})
      UPDATE public.resource_cleanups SET status = 'processing', dispatch_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM due) RETURNING ${columns}`);
    return result.rows;
  });
}

export async function finishResourceCleanup(
  db: DatabaseOrTransaction,
  row: ResourceCleanup,
  outcome: {
    status: Exclude<CleanupStatus, "processing">;
    reason?: string;
    progress?: boolean;
  },
) {
  return primary(db).transaction(async (tx) => {
    // Acquiring an unchanged tuple can wait past the dispatch deadline. Lock
    // first, then evaluate wall-clock expiry in a separate statement below.
    const locked = await tx.execute(
      sql`SELECT id FROM public.resource_cleanups WHERE id = ${row.id}::uuid AND status = 'processing' AND dispatch_token = ${row.dispatchToken}::uuid FOR UPDATE`,
    );
    if (!locked.rows.length) return false;
    const status =
      outcome.status === "pending" && row.attempts >= 8 && !outcome.progress
        ? "failed"
        : outcome.status;
    const result =
      await tx.execute(sql`UPDATE public.resource_cleanups SET status = ${status}, reason = ${outcome.reason ?? null}, updated_at = now(), next_attempt_at = now() + interval '1 minute', dispatch_token = NULL, lease_expires_at = NULL,
      attempts = CASE WHEN ${outcome.progress === true} THEN 0 ELSE attempts END, encrypted_payload = CASE WHEN ${status === "completed"} THEN NULL ELSE encrypted_payload END
      WHERE id = ${row.id}::uuid AND status = 'processing' AND dispatch_token = ${row.dispatchToken}::uuid AND lease_expires_at > clock_timestamp() RETURNING id`);
    if (!result.rows.length) return false;
    if (status === "completed" && row.provider === "composio" && row.teamId) {
      const target = openResourceCleanup(row);
      const liveTeam = await tx.execute(
        sql`SELECT id FROM public.teams WHERE id = ${row.teamId}::uuid`,
      );
      if (liveTeam.rows.length)
        await releaseTeamConnector(tx, {
          teamId: row.teamId,
          id: target.data.reservationId!,
        });
    }
    await appendSecurityAuditEvent(tx, {
      teamId: row.teamId,
      actorUserId: row.actorUserId,
      operation: "cleanup.transition",
      targetType: "cleanup",
      targetId: row.id,
      metadata: {
        status,
        reason: outcome.reason,
        provider: row.provider,
        attempt: row.attempts,
      },
    });
    return true;
  });
}

export async function listResourceCleanups(
  db: DatabaseOrTransaction,
  input: { teamId?: string | null; actorUserId: string },
) {
  const scope = input.teamId
    ? sql`(team_id = ${input.teamId}::uuid OR actor_user_id = ${input.actorUserId}::uuid)`
    : sql`actor_user_id = ${input.actorUserId}::uuid`;
  const result = await primary(db).execute<
    Omit<ResourceCleanup, "encryptedPayload" | "dispatchToken">
  >(
    sql`SELECT id, kind, team_id AS "teamId", actor_user_id AS "actorUserId", target_id AS "targetId", provider, status, attempts, reason, created_at AS "createdAt", updated_at AS "updatedAt" FROM public.resource_cleanups WHERE ${scope} ORDER BY created_at DESC LIMIT 100`,
  );
  return result.rows;
}

export async function acknowledgeManualCleanup(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    teamId?: string | null;
    actorUserId: string;
    evidenceReference: string;
  },
) {
  if (!/^[A-Z0-9][A-Z0-9._:-]{5,127}$/i.test(input.evidenceReference))
    throw new Error(
      "A non-personal operational evidence reference is required",
    );
  return primary(db).transaction(async (tx) => {
    await lockUserMembership(tx, input.actorUserId);
    const found = await tx.execute<ResourceCleanup>(
      sql`SELECT ${columns} FROM public.resource_cleanups WHERE id = ${input.id}::uuid`,
    );
    let row = found.rows[0];
    if (!row || !["manual_required", "unknown", "failed"].includes(row.status))
      throw new Error("Cleanup cannot be acknowledged");
    if (row.teamId) {
      const exists = await tx.execute(
        sql`SELECT id FROM public.teams WHERE id = ${row.teamId}::uuid`,
      );
      if (exists.rows.length)
        requireTeamOwner(
          await lockTeamMembership(tx, row.teamId),
          input.actorUserId,
        );
      else if (row.actorUserId !== input.actorUserId)
        throw new Error("Cleanup belongs to another actor");
    } else if (row.actorUserId !== input.actorUserId)
      throw new Error("Cleanup belongs to another actor");
    const locked = await tx.execute<ResourceCleanup>(
      sql`SELECT ${columns} FROM public.resource_cleanups WHERE id = ${input.id}::uuid FOR UPDATE`,
    );
    row = locked.rows[0];
    if (!row || !["manual_required", "unknown", "failed"].includes(row.status))
      throw new Error("Cleanup state changed; refresh before confirming");
    // Storage/Auth completion requires machine verification; a checkbox cannot erase it.
    if (!["provider", "billing", "retention", "marketing"].includes(row.kind))
      throw new Error("This cleanup requires machine verification");
    if (row.provider === "composio" && row.teamId) {
      const target = openResourceCleanup(row);
      const liveTeam = await tx.execute(
        sql`SELECT id FROM public.teams WHERE id = ${row.teamId}::uuid`,
      );
      if (liveTeam.rows.length)
        await releaseTeamConnector(tx, {
          teamId: row.teamId,
          id: target.data.reservationId!,
        });
    }
    await tx.execute(
      sql`UPDATE public.resource_cleanups SET status = 'completed', reason = 'operator_verified', encrypted_payload = NULL, evidence_reference = ${input.evidenceReference}, updated_at = now() WHERE id = ${row.id}::uuid`,
    );
    await appendSecurityAuditEvent(tx, {
      teamId: row.teamId,
      actorUserId: input.actorUserId,
      operation: "cleanup.acknowledge",
      targetType: "cleanup",
      targetId: row.id,
      metadata: {
        status: "completed",
        reason: "operator_verified",
        provider: row.provider,
      },
    });
    return { id: row.id, status: "completed" as const };
  });
}
