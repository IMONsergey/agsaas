import type { CleanupStatus, CleanupTarget } from "@midday/db/cleanup";
import type { DatabaseOrTransaction } from "@midday/db/client";
import {
  getInboxDeletionDigestPlan,
  retainInboxDeletionDigest,
} from "@midday/db/queries/inbox-deletion-receipts";
import {
  finishResourceCleanup,
  openResourceCleanup,
  type ResourceCleanup,
} from "@midday/db/queries/resource-cleanups";
import { encrypt } from "@midday/encryption";
import { createStorageCleanupClient } from "@midday/supabase/cleanup";
import { readStorageDeletionDigest } from "@midday/supabase/deletion-proof";
import { createClient } from "@midday/supabase/job";
import { sql } from "drizzle-orm";

export type CleanupOutcome = {
  status: Exclude<CleanupStatus, "processing">;
  reason?: string;
  progress?: boolean;
};
const completed = { status: "completed" } as const;
const manual = (reason: string): CleanupOutcome => ({
  status: "manual_required",
  reason,
});

async function request(url: string, init: RequestInit, fetcher: typeof fetch) {
  return fetcher(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
function httpOutcome(response: Response): CleanupOutcome {
  if (response.ok) return completed;
  if (response.status === 429 || response.status >= 500)
    return { status: "pending", reason: "provider_unavailable" };
  return manual("provider_rejected_revocation");
}

/** Official native revoke endpoints only; never pass a stored arbitrary URL to fetch. */
export async function revokeProvider(
  target: CleanupTarget,
  fetcher: typeof fetch = fetch,
): Promise<CleanupOutcome> {
  const { provider, data } = target;
  if (provider === "gmail") {
    const token = data.refreshToken || data.accessToken;
    if (!token) return manual("credentials_missing");
    const response = await request(
      "https://oauth2.googleapis.com/revoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      },
      fetcher,
    );
    // A 400 is not proof of success; retain it for explicit provider-console verification.
    return httpOutcome(response);
  }
  if (provider === "quickbooks") {
    const id = process.env.QUICKBOOKS_CLIENT_ID,
      secret = process.env.QUICKBOOKS_CLIENT_SECRET;
    if (!id || !secret)
      return { status: "pending", reason: "configuration_unavailable" };
    if (!data.refreshToken && !data.accessToken)
      return manual("credentials_missing");
    return httpOutcome(
      await request(
        "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
        {
          method: "POST",
          headers: {
            Authorization: basic(id, secret),
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            token: data.refreshToken || data.accessToken,
          }),
        },
        fetcher,
      ),
    );
  }
  if (provider === "slack") {
    if (!data.accessToken) return manual("credentials_missing");
    const response = await request(
      "https://slack.com/api/auth.revoke",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      },
      fetcher,
    );
    if (!response.ok) return httpOutcome(response);
    const body = (await readProviderJson(response)) as {
      ok?: boolean;
      revoked?: boolean;
      error?: string;
    };
    return (body.ok === true && body.revoked === true) ||
      body.error === "token_revoked"
      ? completed
      : manual("provider_rejected_revocation");
  }
  if (provider === "stripe") {
    const secret = process.env.STRIPE_SECRET_KEY,
      clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!secret || !clientId)
      return { status: "pending", reason: "configuration_unavailable" };
    if (!/^acct_[A-Za-z0-9]+$/.test(data.externalId ?? ""))
      return manual("credentials_missing");
    return httpOutcome(
      await request(
        "https://connect.stripe.com/oauth/deauthorize",
        {
          method: "POST",
          headers: {
            Authorization: basic(secret, ""),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            stripe_user_id: data.externalId!,
          }),
        },
        fetcher,
      ),
    );
  }
  if (provider === "xero") {
    if (!data.accessToken || !data.externalId)
      return manual("credentials_missing");
    // Revoke only this organisation. Revoking the refresh token would remove other tenant grants.
    const response = await request(
      "https://api.xero.com/connections",
      { headers: { Authorization: `Bearer ${data.accessToken}` } },
      fetcher,
    );
    if (!response.ok) return httpOutcome(response);
    const connections = (await readProviderJson(response)) as unknown as Array<{
      id?: string;
      tenantId?: string;
    }>;
    if (!Array.isArray(connections) || connections.length > 1000)
      return manual("provider_response_invalid");
    const connection = connections.find(
      (value) => value.tenantId === data.externalId,
    );
    if (!connection) return completed;
    if (!connection.id || !/^[a-f0-9-]{36}$/i.test(connection.id))
      return manual("provider_response_invalid");
    return httpOutcome(
      await request(
        `https://api.xero.com/connections/${connection.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${data.accessToken}` },
        },
        fetcher,
      ),
    );
  }
  // Microsoft/Fortnox need provider-console/admin consent removal. Do not revoke an entire Microsoft account session.
  return manual("provider_console_required");
}

async function hasOtherGrant(db: DatabaseOrTransaction, target: CleanupTarget) {
  const external = target.data.externalId;
  if (!external) return false;
  const result = await db.execute<{ shared: boolean }>(sql`SELECT (
    EXISTS (SELECT 1 FROM public.apps WHERE app_id = ${target.provider} AND COALESCE(config->>'tenantId', config->>'realmId', config->>'companyId', config->>'team_id') = ${external}) OR
    EXISTS (SELECT 1 FROM public.inbox_accounts WHERE provider::text = ${target.provider} AND external_id = ${external}) OR
    (${target.provider === "stripe"} AND EXISTS (SELECT 1 FROM public.teams WHERE stripe_account_id = ${external}))) AS shared`);
  return result.rows[0]?.shared === true;
}

/** Legacy receipts lack an original hash. A bounded best-effort read can retain
 * one before erasure; unavailable evidence never delays or reverses deletion. */
async function retainLegacyDeletionProof(
  db: DatabaseOrTransaction,
  row: ResourceCleanup,
  target: CleanupTarget,
) {
  try {
    const plan = await getInboxDeletionDigestPlan(db, row);
    if (!plan.pending) return;
    const evidence =
      plan.maximumBytes > 0
        ? await readStorageDeletionDigest(
            { teamId: target.teamId! },
            target.data.path!,
            plan.maximumBytes,
          ).catch(() => ({ failure: "download_unavailable" as const }))
        : { failure: "size_unverifiable" as const };
    await retainInboxDeletionDigest(db, row, evidence);
  } catch {
    // Keep the ledger's unknown proof. Cleanup must still erase the object even
    // if the optional proof read/save is unavailable or its lease became stale.
  }
}

export async function executeResourceCleanup(
  db: DatabaseOrTransaction,
  row: ResourceCleanup,
): Promise<CleanupOutcome> {
  const target = openResourceCleanup(row);
  if (target.kind === "provider") {
    if (target.provider === "composio") {
      try {
        return await cleanupComposio(db, row, target);
      } catch {
        return { status: "unknown", reason: "provider_result_unknown" };
      }
    }
    if (await hasOtherGrant(db, target)) return manual("grant_still_used");
    try {
      return await revokeProvider(target);
    } catch {
      return { status: "unknown", reason: "provider_result_unknown" };
    }
  }
  if (target.kind === "storage-object") {
    await retainLegacyDeletionProof(db, row, target);
    await createStorageCleanupClient({ teamId: target.teamId! }).remove(
      "vault",
      [target.data.path!],
    );
    const result = await db.execute<{ exists: boolean }>(
      sql`SELECT private.cleanup_storage_object_exists(${row.id}::uuid, ${row.dispatchToken}::uuid, ${target.data.path}) AS exists`,
    );
    return result.rows[0]?.exists
      ? { status: "pending", reason: "storage_not_empty", progress: true }
      : completed;
  }
  if (target.kind === "storage-team" || target.kind === "storage-user") {
    const storage = createStorageCleanupClient(
      target.kind === "storage-team"
        ? { teamId: target.teamId! }
        : { userId: target.actorUserId! },
    );
    // One bounded batch per claim. The durable ledger continues across any number of batches.
    const result = await db.execute<{ bucket: string; name: string }>(
      sql`SELECT * FROM private.cleanup_storage_batch(${row.id}::uuid, ${row.dispatchToken}::uuid)`,
    );
    if (result.rows.length === 0) return completed;
    for (const bucket of ["vault", "avatars", "apps"]) {
      const names = result.rows
        .filter((item) => item.bucket === bucket)
        .map((item) => item.name);
      if (names.length) await storage.remove(bucket, names);
    }
    return {
      status: "pending",
      reason: "storage_batch_removed",
      progress: true,
    };
  }
  if (target.kind === "auth-user") {
    const { error } = await createClient().auth.admin.deleteUser(
      target.targetId,
    );
    if (error && error.code !== "user_not_found")
      return { status: "pending", reason: "auth_cleanup_unconfirmed" };
    // Remove an old profile only after Auth confirms deletion. Membership was already removed atomically.
    await db.execute(
      sql`DELETE FROM public.users WHERE id = ${target.targetId}::uuid AND deletion_started_at IS NOT NULL`,
    );
    return completed;
  }
  if (target.kind === "marketing") {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { status: "pending", reason: "configuration_unavailable" };
    if (!target.data.email || !target.data.audienceId)
      return manual("credentials_missing");
    const response = await request(
      `https://api.resend.com/audiences/${encodeURIComponent(target.data.audienceId)}/contacts/${encodeURIComponent(target.data.email)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${key}` } },
      fetch,
    );
    return response.status === 404 ? completed : httpOutcome(response);
  }
  return manual(
    target.kind === "billing"
      ? "billing_retention_review"
      : "backup_and_legacy_asset_review",
  );
}

export async function runResourceCleanup(
  db: DatabaseOrTransaction,
  row: ResourceCleanup,
) {
  let outcome: CleanupOutcome;
  try {
    outcome = await executeResourceCleanup(db, row);
  } catch {
    outcome = { status: "pending", reason: "cleanup_unconfirmed" };
  }
  await finishResourceCleanup(db, row, outcome);
  return outcome.status;
}

async function readProviderJson(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Provider response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024)
        throw new Error("Provider response exceeds its limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function cleanupComposio(
  db: DatabaseOrTransaction,
  row: ResourceCleanup,
  target: CleanupTarget,
): Promise<CleanupOutcome> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey)
    return { status: "pending", reason: "configuration_unavailable" };
  if (
    !target.data.externalId ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(target.data.externalId) ||
    target.data.entityId !== `agsaas-team-${target.teamId}`
  )
    return manual("provider_connection_reconciliation");
  const id = target.data.externalId;
  const headers = { "x-api-key": apiKey };
  if (target.data.revocationConfirmed !== "true") {
    const response = await request(
      `https://backend.composio.dev/api/v3/connected_accounts/${id}`,
      { headers },
      fetch,
    );
    if (!response.ok) return manual("provider_connection_reconciliation");
    const account = await readProviderJson(response);
    if (
      account.user_id !== target.data.entityId &&
      account.userId !== target.data.entityId
    )
      return manual("provider_ownership_mismatch");
    const revoke = await request(
      `https://backend.composio.dev/api/v3.1/connected_accounts/${id}/revoke`,
      { method: "POST", headers },
      fetch,
    );
    if (!revoke.ok) return httpOutcome(revoke);
    const body = await readProviderJson(revoke);
    const accountResult = body.connected_account as
      | { id?: string; status?: string }
      | undefined;
    const subjects = body.revoked_tokens;
    if (
      accountResult?.id !== id ||
      accountResult.status !== "REVOKED" ||
      !Array.isArray(subjects) ||
      !subjects.includes("access_token") ||
      !subjects.includes("refresh_token")
    )
      return manual("provider_partial_revocation");
    // Retain proof before delete. A crash cannot turn a later 404 into invented upstream-revoke proof.
    target.data.revocationConfirmed = "true";
    const saved = await db.execute(
      sql`UPDATE public.resource_cleanups SET encrypted_payload = ${encrypt(JSON.stringify(target))}, updated_at = now() WHERE id = ${row.id}::uuid AND status = 'processing' AND dispatch_token = ${row.dispatchToken}::uuid RETURNING id`,
    );
    if (!saved.rows.length)
      return { status: "unknown", reason: "dispatch_interrupted" };
  }
  const removed = await request(
    `https://backend.composio.dev/api/v3/connected_accounts/${id}`,
    { method: "DELETE", headers },
    fetch,
  );
  return removed.ok || removed.status === 404
    ? completed
    : { status: "pending", reason: "provider_delete_unconfirmed" };
}
