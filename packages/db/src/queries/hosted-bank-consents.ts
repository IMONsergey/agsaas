import { createHash, randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@midday/encryption";
import { and, eq, sql } from "drizzle-orm";
import {
  BankConsentError,
  consentIdentifier,
  type HostedConsentActor,
  type HostedConsentPayload,
  type HostedConsentScope,
  type HostedConsentStatus,
  type VerifiedConsentAccount,
  validateConsentAccounts,
  verifyConsentEnvelope,
} from "../bank-consent";
import type { DatabaseOrTransaction, TransactionClient } from "../client";
import { bankAccounts, bankConnections } from "../schema";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamOwner,
} from "../utils/team-membership";
import { retainBankConnectionCleanup } from "./bank-connection-cleanups";
import { requestBankSync } from "./bank-sync";
import { appendSecurityAuditEvent } from "./security-audit";
import { getTeamEntitlements } from "./team-entitlements";

export type HostedBankConsent = HostedConsentScope & {
  id: string;
  requestId: string;
  providerEnvironment: "sandbox" | "production";
  status: HostedConsentStatus;
  claimToken: string | null;
  encryptedPayload: string;
  connectionId: string | null;
  cleanupId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** SQL observation time; public projection must not trust the API host clock. */
  observedAt: string;
};

const columns = sql`id,team_id AS "teamId",user_id AS "userId",session_id AS "sessionId",
  request_id AS "requestId",provider_environment AS "providerEnvironment",status,
  claim_token AS "claimToken",encrypted_payload AS "encryptedPayload",connection_id AS "connectionId",
  cleanup_id AS "cleanupId",reason,created_at::text AS "createdAt",updated_at::text AS "updatedAt",expires_at::text AS "expiresAt",clock_timestamp()::text AS "observedAt"`;

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Drizzle primary routing is not a React hook.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}

async function consentExpired(tx: TransactionClient, expiresAt: string) {
  const result = await tx.execute<{ expired: boolean }>(
    sql`SELECT ${expiresAt}::timestamptz <= clock_timestamp() AS expired`,
  );
  if (typeof result.rows[0]?.expired !== "boolean")
    throw new BankConsentError("state_changed");
  return result.rows[0].expired;
}

async function lockScope(tx: TransactionClient, scope: HostedConsentActor) {
  await lockUserMembership(tx, scope.userId);
  requireTeamOwner(await lockTeamMembership(tx, scope.teamId), scope.userId);
  const session = await tx.execute<{ active: boolean }>(sql`
    SELECT private.lock_hosted_bank_consent_session(${scope.userId}::uuid,${scope.sessionId}::uuid,${scope.aal}) active`);
  if (session.rows[0]?.active !== true)
    throw new BankConsentError("session_expired");
}

async function rowForUpdate(
  tx: TransactionClient,
  id: string,
  scope?: HostedConsentScope,
) {
  const result =
    await tx.execute<HostedBankConsent>(sql`SELECT ${columns} FROM public.hosted_bank_consents WHERE id=${id}::uuid
    ${scope ? sql`AND team_id=${scope.teamId}::uuid AND user_id=${scope.userId}::uuid AND session_id=${scope.sessionId}::uuid` : sql``} FOR UPDATE`);
  if (!result.rows[0]) throw new BankConsentError("not_found");
  return result.rows[0];
}

function assertScope(row: HostedBankConsent, scope: HostedConsentScope) {
  if (
    row.teamId !== scope.teamId ||
    row.userId !== scope.userId ||
    row.sessionId !== scope.sessionId
  )
    throw new BankConsentError("not_found");
}

export function openHostedBankConsent(
  row: HostedBankConsent,
): HostedConsentPayload {
  try {
    const payload = verifyConsentEnvelope(
      JSON.parse(decrypt(row.encryptedPayload)),
      row,
    );
    if (payload.environment !== row.providerEnvironment)
      throw new Error("Environment binding differs");
    return payload;
  } catch {
    throw new BankConsentError("invalid_provider_data");
  }
}

function seal(payload: HostedConsentPayload) {
  verifyConsentEnvelope(payload, payload);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > 262144)
    throw new BankConsentError("invalid_provider_data");
  return encrypt(serialized);
}

function identityOnly(payload: HostedConsentPayload): HostedConsentPayload {
  return {
    version: 1,
    id: payload.id,
    teamId: payload.teamId,
    userId: payload.userId,
    sessionId: payload.sessionId,
    provider: "plaid",
    environment: payload.environment,
    clientFingerprint: payload.clientFingerprint,
    country: payload.country,
  };
}

/** Never serialize the retained envelope or provider credentials to a caller. */
export function hostedBankConsentView(
  row: HostedBankConsent,
  includeHostedUrl = false,
) {
  let url: string | undefined;
  if (
    includeHostedUrl &&
    row.status === "awaiting_consent" &&
    Date.parse(row.expiresAt) > Date.parse(row.observedAt)
  )
    url = openHostedBankConsent(row).hostedUrl;
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    expiresAt: row.expiresAt,
    connectionId: row.connectionId,
    cleanupId: row.cleanupId,
    ...(url ? { url } : {}),
  };
}

export async function getHostedBankConsent(
  db: DatabaseOrTransaction,
  scope: HostedConsentActor,
  id: string,
) {
  return primary(db).transaction(async (tx) => {
    await lockScope(tx, scope);
    const row = await rowForUpdate(tx, id, scope);
    assertScope(row, scope);
    return row;
  });
}

/** Only the initiating owner and current session can resume a capability URL. */
export async function listHostedBankConsents(
  db: DatabaseOrTransaction,
  scope: HostedConsentActor,
) {
  return primary(db).transaction(async (tx) => {
    await lockScope(tx, scope);
    const result =
      await tx.execute<HostedBankConsent>(sql`SELECT ${columns} FROM public.hosted_bank_consents
      WHERE team_id=${scope.teamId}::uuid AND user_id=${scope.userId}::uuid AND session_id=${scope.sessionId}::uuid
      ORDER BY created_at DESC,id LIMIT 10`);
    return result.rows.map((row) => hostedBankConsentView(row, true));
  });
}

/** The command identity survives retries; only the first committed creator may call Plaid. */
export async function beginHostedBankConsent(
  db: DatabaseOrTransaction,
  input: HostedConsentActor & {
    requestId: string;
    environment: "sandbox" | "production";
    clientFingerprint: string;
    country: "US" | "CA";
  },
) {
  return primary(db).transaction(async (tx) => {
    await lockScope(tx, input);
    const existing =
      await tx.execute<HostedBankConsent>(sql`SELECT ${columns} FROM public.hosted_bank_consents
      WHERE team_id=${input.teamId}::uuid AND user_id=${input.userId}::uuid AND request_id=${input.requestId}::uuid FOR UPDATE`);
    if (existing.rows[0]) {
      assertScope(existing.rows[0], input);
      const payload = openHostedBankConsent(existing.rows[0]);
      if (
        payload.environment !== input.environment ||
        payload.clientFingerprint !== input.clientFingerprint ||
        payload.country !== input.country
      )
        throw new BankConsentError("scope_changed");
      return { row: existing.rows[0], created: false };
    }
    await tx.execute(
      sql`SELECT public.agsaas_quota_lock(${input.teamId}::uuid)`,
    );
    const entitlement = await getTeamEntitlements(tx, input.teamId);
    if (
      entitlement.pastDue ||
      entitlement.usage.bankConnections >= entitlement.limits.bankConnections
    )
      throw new BankConsentError("quota_unavailable");
    const cleanup =
      await tx.execute(sql`SELECT 1 FROM public.bank_connection_cleanups
      WHERE team_id=${input.teamId}::uuid AND provider='plaid' AND status<>'completed' LIMIT 1`);
    if (cleanup.rows.length)
      throw new BankConsentError("provider_cleanup_pending");
    const unresolved =
      await tx.execute(sql`SELECT 1 FROM public.hosted_bank_consents
      WHERE team_id=${input.teamId}::uuid AND status IN ('reconciliation','cleanup_requested') LIMIT 1`);
    if (unresolved.rows.length)
      throw new BankConsentError("provider_cleanup_pending");
    const pending = await tx.execute<{
      active: number;
      recent: number;
    }>(sql`SELECT
      count(*) FILTER (WHERE status IN ('creating','awaiting_consent','exchanging','grant_received','verified'))::int active,
      count(*) FILTER (WHERE created_at>clock_timestamp()-interval '24 hours')::int recent
      FROM public.hosted_bank_consents WHERE team_id=${input.teamId}::uuid AND user_id=${input.userId}::uuid`);
    if (
      (pending.rows[0]?.active ?? 0) >= 3 ||
      (pending.rows[0]?.recent ?? 0) >= 10
    )
      throw new BankConsentError("pending_limit");
    const id = randomUUID(),
      claimToken = randomUUID();
    const payload: HostedConsentPayload = {
      version: 1,
      id,
      teamId: input.teamId,
      userId: input.userId,
      sessionId: input.sessionId,
      provider: "plaid",
      environment: input.environment,
      clientFingerprint: input.clientFingerprint,
      country: input.country,
    };
    const inserted =
      await tx.execute<HostedBankConsent>(sql`INSERT INTO public.hosted_bank_consents
      (id,team_id,user_id,session_id,request_id,provider,provider_environment,status,claim_token,encrypted_payload,expires_at)
      VALUES (${id}::uuid,${input.teamId}::uuid,${input.userId}::uuid,${input.sessionId}::uuid,${input.requestId}::uuid,
      'plaid',${input.environment},'creating',${claimToken}::uuid,${seal(payload)},clock_timestamp()+interval '30 minutes') RETURNING ${columns}`);
    const row = inserted.rows[0];
    if (!row) throw new BankConsentError("state_changed");
    await appendSecurityAuditEvent(tx, {
      teamId: input.teamId,
      actorUserId: input.userId,
      operation: "bank.consent_start",
      targetType: "bank_consent",
      targetId: id,
      metadata: { provider: "plaid", status: "creating" },
    });
    return { row, created: true };
  });
}

export async function retainHostedBankLink(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    claimToken: string;
    linkToken: string;
    hostedUrl: string;
    expiresAt: string;
  },
) {
  return primary(db).transaction(async (tx) => {
    const row = await rowForUpdate(tx, input.id);
    if (
      row.claimToken !== input.claimToken ||
      !["creating", "cleanup_requested", "reconciliation"].includes(row.status)
    )
      throw new BankConsentError("state_changed");
    const payload = openHostedBankConsent(row);
    const expires = Math.min(
      new Date(input.expiresAt).getTime(),
      new Date(row.expiresAt).getTime(),
    );
    if (
      !Number.isFinite(expires) ||
      (await consentExpired(tx, new Date(expires).toISOString()))
    )
      throw new BankConsentError("invalid_provider_data");
    const next =
      row.status === "creating" ? "awaiting_consent" : "reconciliation";
    const result =
      await tx.execute<HostedBankConsent>(sql`UPDATE public.hosted_bank_consents SET
      encrypted_payload=${seal({ ...payload, linkToken: input.linkToken, hostedUrl: input.hostedUrl })},
      status=${next},claim_token=NULL,expires_at=${new Date(expires).toISOString()}::timestamptz,updated_at=clock_timestamp()
      WHERE id=${row.id}::uuid RETURNING ${columns}`);
    return result.rows[0]!;
  });
}

export async function markHostedBankConsentUncertain(
  db: DatabaseOrTransaction,
  id: string,
  claimToken: string,
) {
  await primary(
    db,
  ).execute(sql`UPDATE public.hosted_bank_consents SET status='reconciliation',reason='provider_outcome_unknown',updated_at=clock_timestamp()
    WHERE id=${id}::uuid AND claim_token=${claimToken}::uuid AND status IN ('creating','exchanging')`);
}

/** Read-only provider evidence precedes this durable, exclusive exchange fence. */
export async function claimHostedBankExchange(
  db: DatabaseOrTransaction,
  scope: HostedConsentActor,
  input: {
    id: string;
    publicToken: string;
    linkSessionId: string;
  },
) {
  return primary(db).transaction(async (tx) => {
    await lockScope(tx, scope);
    const row = await rowForUpdate(tx, input.id, scope);
    assertScope(row, scope);
    if (row.status !== "awaiting_consent") return { row, claimed: false };
    if (await consentExpired(tx, row.expiresAt))
      throw new BankConsentError("state_changed");
    const payload = openHostedBankConsent(row),
      claimToken = randomUUID();
    const result =
      await tx.execute<HostedBankConsent>(sql`UPDATE public.hosted_bank_consents SET
      encrypted_payload=${seal({ ...payload, publicToken: input.publicToken, linkSessionId: input.linkSessionId })},
      status='exchanging',claim_token=${claimToken}::uuid,updated_at=clock_timestamp() WHERE id=${row.id}::uuid RETURNING ${columns}`);
    return { row: result.rows[0]!, claimed: true };
  });
}

async function retainUnacceptedGrant(
  tx: TransactionClient,
  row: HostedBankConsent,
  payload: HostedConsentPayload,
  reason: string,
) {
  if (payload.identityConflict || !payload.accessToken || !payload.itemId) {
    const result =
      await tx.execute<HostedBankConsent>(sql`UPDATE public.hosted_bank_consents SET
      status='reconciliation',reason=${payload.identityConflict ? "provider_identity_conflict" : reason},updated_at=clock_timestamp()
      WHERE id=${row.id}::uuid RETURNING ${columns}`);
    return result.rows[0]!;
  }
  const cleanup = await retainBankConnectionCleanup(tx, {
    id: row.id,
    teamId: row.teamId,
    provider: "plaid",
    referenceId: payload.itemId,
    accessToken: payload.accessToken,
  });
  const result =
    await tx.execute<HostedBankConsent>(sql`UPDATE public.hosted_bank_consents SET
    status='cleanup_pending',cleanup_id=${cleanup.id}::uuid,reason=${reason},claim_token=NULL,
    encrypted_payload=${seal(identityOnly(payload))},updated_at=clock_timestamp()
    WHERE id=${row.id}::uuid RETURNING ${columns}`);
  return result.rows[0]!;
}

/** Persist the exchange receipt before any further provider reads. A later
 * accounts/institution outage must not discard the only revocation credential. */
export async function retainHostedBankAccess(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    claimToken: string;
    accessToken: string;
    itemId: string;
  },
) {
  if (
    ![input.accessToken, input.itemId].every((value) =>
      consentIdentifier(value, 4096),
    )
  )
    throw new BankConsentError("invalid_provider_data");
  return primary(db).transaction(async (tx) => {
    const row = await rowForUpdate(tx, input.id);
    if (
      row.claimToken !== input.claimToken ||
      !["exchanging", "cleanup_requested", "reconciliation"].includes(
        row.status,
      )
    )
      throw new BankConsentError("state_changed");
    const previous = openHostedBankConsent(row);
    const hash = createHash("sha256")
      .update(`${previous.environment}:${input.itemId}`)
      .digest("hex");
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agsaas:plaid-item:${hash}`},0))`,
    );
    const conflict =
      await tx.execute(sql`SELECT 1 FROM public.hosted_bank_consents WHERE provider_identity_hash=${hash} AND id<>${row.id}::uuid
      UNION ALL SELECT 1 FROM public.bank_connections WHERE provider='plaid' AND reference_id=${input.itemId} AND id<>${row.id}::uuid LIMIT 1`);
    const payload: HostedConsentPayload = {
      ...previous,
      accessToken: input.accessToken,
      itemId: input.itemId,
      identityConflict: conflict.rows.length > 0,
    };
    const result =
      await tx.execute<HostedBankConsent>(sql`UPDATE public.hosted_bank_consents SET
      encrypted_payload=${seal(payload)},provider_identity_hash=${payload.identityConflict ? null : hash},
      status=${payload.identityConflict ? "reconciliation" : "grant_received"},
      reason=${payload.identityConflict ? "provider_identity_conflict" : row.reason},updated_at=clock_timestamp()
      WHERE id=${row.id}::uuid RETURNING ${columns}`);
    const saved = result.rows[0]!;
    if (
      !payload.identityConflict &&
      (row.status === "cleanup_requested" ||
        [
          "scope_revoked",
          "abandoned_consent_review",
          "consent_expired",
        ].includes(row.reason ?? "") ||
        (await consentExpired(tx, row.expiresAt)))
    )
      return retainUnacceptedGrant(
        tx,
        saved,
        payload,
        row.reason === "scope_revoked"
          ? "scope_revoked"
          : row.reason === "abandoned_consent_review"
            ? "abandoned_consent_review"
            : "consent_expired",
      );
    return saved;
  });
}

/** Verified account metadata belongs to the already retained exact Item. */
export async function retainHostedBankGrant(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    claimToken: string;
    accessToken: string;
    itemId: string;
    institutionId: string;
    institutionName: string;
    accounts: VerifiedConsentAccount[];
  },
) {
  if (
    ![input.institutionId, input.institutionName].every((value) =>
      consentIdentifier(value, 4096),
    )
  )
    throw new BankConsentError("invalid_provider_data");
  const accounts = validateConsentAccounts(input.accounts);
  return primary(db).transaction(async (tx) => {
    const row = await rowForUpdate(tx, input.id);
    if (
      row.claimToken !== input.claimToken ||
      !["grant_received", "verified", "cleanup_requested"].includes(row.status)
    )
      throw new BankConsentError("state_changed");
    const previous = openHostedBankConsent(row);
    if (
      previous.accessToken !== input.accessToken ||
      previous.itemId !== input.itemId ||
      previous.identityConflict
    )
      throw new BankConsentError("invalid_provider_data");
    if (row.status === "verified") return row;
    const payload: HostedConsentPayload = {
      ...previous,
      institutionId: input.institutionId,
      institutionName: input.institutionName,
      accounts,
    };
    if (
      row.status === "cleanup_requested" ||
      (await consentExpired(tx, row.expiresAt))
    )
      return retainUnacceptedGrant(
        tx,
        row,
        payload,
        row.reason === "scope_revoked" ? "scope_revoked" : "consent_expired",
      );
    const result =
      await tx.execute<HostedBankConsent>(sql`UPDATE public.hosted_bank_consents SET
      status='verified',reason=NULL,encrypted_payload=${seal(payload)},updated_at=clock_timestamp()
      WHERE id=${row.id}::uuid RETURNING ${columns}`);
    return result.rows[0]!;
  });
}

/** Accounts, connection, audit and the native SQL sync intent commit together. */
export async function acceptHostedBankConsent(
  db: DatabaseOrTransaction,
  scope: HostedConsentActor,
  id: string,
) {
  return primary(db).transaction(async (tx) => {
    await lockScope(tx, scope);
    const row = await rowForUpdate(tx, id, scope);
    assertScope(row, scope);
    if (row.status === "completed") return row;
    if (row.status !== "verified") return row;
    const payload = openHostedBankConsent(row);
    if (
      !payload.accessToken ||
      !payload.itemId ||
      !payload.institutionId ||
      !payload.institutionName ||
      payload.identityConflict
    )
      throw new BankConsentError("invalid_provider_data");
    const accounts = validateConsentAccounts(payload.accounts);
    if (await consentExpired(tx, row.expiresAt))
      return retainUnacceptedGrant(tx, row, payload, "consent_expired");
    await tx.execute(
      sql`SELECT public.agsaas_quota_lock(${scope.teamId}::uuid)`,
    );
    const entitlement = await getTeamEntitlements(tx, scope.teamId);
    if (
      entitlement.pastDue ||
      entitlement.usage.bankConnections >= entitlement.limits.bankConnections
    )
      return retainUnacceptedGrant(tx, row, payload, "quota_unavailable");
    const cleanup =
      await tx.execute(sql`SELECT 1 FROM public.bank_connection_cleanups
      WHERE team_id=${scope.teamId}::uuid AND provider='plaid' AND status<>'completed' LIMIT 1`);
    if (cleanup.rows.length)
      return retainUnacceptedGrant(
        tx,
        row,
        payload,
        "provider_cleanup_pending",
      );
    const existing = await tx
      .select({ id: bankConnections.id })
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.teamId, scope.teamId),
          eq(bankConnections.institutionId, payload.institutionId),
        ),
      )
      .for("update");
    if (existing.length)
      return retainUnacceptedGrant(tx, row, payload, "connection_exists");
    await tx.insert(bankConnections).values({
      id: row.id,
      teamId: scope.teamId,
      provider: "plaid",
      name: payload.institutionName,
      institutionId: payload.institutionId,
      referenceId: payload.itemId,
      accessToken: payload.accessToken,
      status: "connected",
      lastAccessed: null,
    });
    await tx.insert(bankAccounts).values(
      accounts.map((account) => ({
        id: randomUUID(),
        teamId: scope.teamId,
        bankConnectionId: row.id,
        createdBy: scope.userId,
        accountId: account.accountId,
        name: account.name,
        currency: account.currency,
        type: account.type,
        subtype: account.subtype,
        manual: false,
        enabled: true,
        balance: null,
      })),
    );
    if (
      !(await requestBankSync(tx, {
        connectionId: row.id,
        teamId: scope.teamId,
        fullHistory: true,
        // The durable queue accepts only SHA-256 event identities.
        eventKey: createHash("sha256")
          .update(`consent:${row.id}`)
          .digest("hex"),
      }))
    )
      throw new BankConsentError("state_changed");
    await appendSecurityAuditEvent(tx, {
      teamId: scope.teamId,
      actorUserId: scope.userId,
      operation: "bank.connect",
      targetType: "bank_connection",
      targetId: row.id,
      metadata: { provider: "plaid", count: accounts.length, connected: true },
    });
    const result =
      await tx.execute<HostedBankConsent>(sql`UPDATE public.hosted_bank_consents SET
      status='completed',connection_id=${row.id}::uuid,claim_token=NULL,reason=NULL,
      encrypted_payload=${seal(identityOnly(payload))},updated_at=clock_timestamp()
      WHERE id=${row.id}::uuid RETURNING ${columns}`);
    return result.rows[0]!;
  });
}

export async function cancelHostedBankConsent(
  db: DatabaseOrTransaction,
  scope: HostedConsentActor,
  id: string,
) {
  return primary(db).transaction(async (tx) => {
    await lockScope(tx, scope);
    const row = await rowForUpdate(tx, id, scope);
    assertScope(row, scope);
    if (
      ["completed", "cleanup_pending", "canceled"].includes(row.status) ||
      (row.status === "reconciliation" &&
        row.reason === "abandoned_consent_review")
    )
      return row;
    const result = await retainUnacceptedGrant(
      tx,
      row,
      openHostedBankConsent(row),
      "abandoned_consent_review",
    );
    await appendSecurityAuditEvent(tx, {
      teamId: scope.teamId,
      actorUserId: scope.userId,
      operation: "bank.consent_cancel",
      targetType: "bank_consent",
      targetId: id,
      metadata: { provider: "plaid", status: result.status },
    });
    return result;
  });
}

/** Never replays create/exchange IO. Known grants go to existing durable revoke;
 * uncertain or abandoned grants remain explicit operator reconciliation. */
export async function reconcileHostedBankConsents(
  db: DatabaseOrTransaction,
  limit = 20,
) {
  const batchSize = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), 50)
    : 20;
  // Confirmation comes only from the existing durable cleanup's provider proof.
  await primary(db).execute(sql`WITH confirmed AS (
    SELECT c.id FROM public.hosted_bank_consents c JOIN public.bank_connection_cleanups cleanup ON cleanup.id=c.cleanup_id
    WHERE c.status='cleanup_pending' AND cleanup.status='completed' ORDER BY c.updated_at,c.id
    LIMIT ${batchSize} FOR UPDATE OF c SKIP LOCKED
  ) UPDATE public.hosted_bank_consents c SET
    status='canceled',updated_at=clock_timestamp()
    FROM confirmed WHERE c.id=confirmed.id`);
  const result = await primary(db).execute<{
    id: string;
  }>(sql`SELECT id FROM public.hosted_bank_consents
    WHERE status='cleanup_requested' OR (expires_at<=clock_timestamp() AND status IN ('creating','awaiting_consent','exchanging','grant_received','verified'))
    ORDER BY expires_at,id LIMIT ${batchSize}`);
  let retained = 0;
  for (const entry of result.rows) {
    await primary(db).transaction(async (tx) => {
      const row = await rowForUpdate(tx, entry.id);
      if (
        row.status !== "cleanup_requested" &&
        (![
          "creating",
          "awaiting_consent",
          "exchanging",
          "grant_received",
          "verified",
        ].includes(row.status) ||
          !(await consentExpired(tx, row.expiresAt)))
      )
        return;
      await retainUnacceptedGrant(
        tx,
        row,
        openHostedBankConsent(row),
        row.reason === "scope_revoked"
          ? "scope_revoked"
          : row.reason === "abandoned_consent_review"
            ? "abandoned_consent_review"
            : "consent_expired",
      );
      retained++;
    });
  }
  return retained;
}

/** A cleanup for a native consent keeps the provider/client binding even after
 * account, team or session deletion. Legacy connections have no such record.
 * Missing SQL, corrupt ciphertext or conflicting identity must fail closed. */
export async function getHostedBankCleanupBinding(
  db: DatabaseOrTransaction,
  cleanup: {
    id: string;
    connectionId: string;
    teamId: string;
    provider: string | null;
  },
) {
  const result = await primary(
    db,
  ).execute<HostedBankConsent>(sql`SELECT ${columns}
    FROM public.hosted_bank_consents WHERE id=${cleanup.connectionId}::uuid`);
  const row = result.rows[0];
  if (!row) return null;
  const payload = openHostedBankConsent(row);
  if (
    cleanup.provider !== "plaid" ||
    row.teamId !== cleanup.teamId ||
    (row.cleanupId !== cleanup.id && row.connectionId !== cleanup.connectionId)
  )
    throw new BankConsentError("invalid_provider_data");
  return {
    environment: payload.environment,
    clientFingerprint: payload.clientFingerprint,
  };
}
