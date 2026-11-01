import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import {
  INVOICE_EMAIL_ENVELOPE_MAX_BYTES,
  INVOICE_EMAIL_LEASE_SECONDS,
  INVOICE_EMAIL_MAX_ATTEMPTS,
  INVOICE_EMAIL_REPLAY_WINDOW_MS,
  type InvoiceEmailActivity,
  type InvoiceEmailDeliveryKind,
} from "../invoice-email-delivery";
import {
  activities,
  invoiceEmailDeliveries,
  invoices,
  users,
  usersOnTeam,
} from "../schema";
import {
  canSendInvoiceEmail,
  canSendInvoiceReminder,
  isCurrentInvoiceSchedule,
  recordInvoiceEmailAccepted,
  recordInvoiceReminderAccepted,
} from "./invoice-delivery";

export type InvoiceEmailDelivery = typeof invoiceEmailDeliveries.$inferSelect;
export type {
  InvoiceEmailActivity,
  InvoiceEmailDeliveryKind,
} from "../invoice-email-delivery";
export { INVOICE_EMAIL_ENVELOPE_MAX_BYTES } from "../invoice-email-delivery";
export type InvoiceEmailDeliveryScope = {
  teamId: string;
  invoiceId: string;
  operationKey: string;
};

export function invoiceEmailEnvelopeHash(envelope: string): string {
  return createHash("sha256").update(envelope).digest("hex");
}

export function validateInvoiceEmailEnvelope(
  envelope: string,
  hash: string,
): void {
  if (
    Buffer.byteLength(envelope, "utf8") > INVOICE_EMAIL_ENVELOPE_MAX_BYTES ||
    invoiceEmailEnvelopeHash(envelope) !== hash
  )
    throw new Error("Invoice email envelope integrity check failed");
}

/** Provider retention uses real elapsed time; an observed DB clock regression
 * must never silently extend our replay window. Future due/lease times are
 * legitimate, but all stored timestamps must parse and past events must remain
 * ordered. This is fail-closed protection, not a distributed clock guarantee.
 */
export function invoiceEmailClockIsUnsafe(
  row: Pick<
    InvoiceEmailDelivery,
    | "createdAt"
    | "updatedAt"
    | "firstAttemptAt"
    | "nextAttemptAt"
    | "leaseExpiresAt"
  >,
  nowText: string,
): boolean {
  const now = new Date(nowText).getTime();
  const created = new Date(row.createdAt).getTime();
  const updated = new Date(row.updatedAt).getTime();
  const first =
    row.firstAttemptAt === null ? null : new Date(row.firstAttemptAt).getTime();
  const next = new Date(row.nextAttemptAt).getTime();
  const lease =
    row.leaseExpiresAt === null ? null : new Date(row.leaseExpiresAt).getTime();
  if (
    [now, created, updated, next, first, lease].some(
      (value) => value !== null && !Number.isFinite(value),
    )
  )
    return true;
  return (
    now < created ||
    now < updated ||
    updated < created ||
    (first !== null && (now < first || first < created || updated < first))
  );
}

function scopeCondition(scope: InvoiceEmailDeliveryScope) {
  return and(
    eq(invoiceEmailDeliveries.teamId, scope.teamId),
    eq(invoiceEmailDeliveries.invoiceId, scope.invoiceId),
    eq(invoiceEmailDeliveries.operationKey, scope.operationKey),
  );
}

/** Primary only: a stale replica must never turn an accepted operation into a new send. */
export async function getInvoiceEmailDelivery(
  db: DatabaseOrTransaction,
  scope: InvoiceEmailDeliveryScope,
) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing method, not a React hook.
  const primary = "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
  const [row] = await primary
    .select()
    .from(invoiceEmailDeliveries)
    .where(scopeCondition(scope))
    .limit(1);
  return row ?? null;
}

export async function prepareInvoiceEmailDelivery(
  db: DatabaseOrTransaction,
  params: InvoiceEmailDeliveryScope & {
    kind: InvoiceEmailDeliveryKind;
    expectedScheduledJobId?: string;
    recipient: string;
    envelope: string;
    activitySnapshot: InvoiceEmailActivity[];
  },
) {
  if (!/^[a-f0-9]{64}$/.test(params.operationKey))
    throw new Error("Invalid invoice email operation key");
  const envelopeHash = invoiceEmailEnvelopeHash(params.envelope);
  validateInvoiceEmailEnvelope(params.envelope, envelopeHash);
  return db.transaction(async (tx) => {
    // All lifecycle methods take invoice then outbox locks in that order.
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, params.invoiceId),
          eq(invoices.teamId, params.teamId),
        ),
      )
      .for("update");
    if (!invoice) throw new Error("Invoice email target not found");
    const existing = await getInvoiceEmailDelivery(tx, params);
    if (existing) return existing; // Never overwrite previously rendered bytes.
    const eligible =
      params.kind === "reminder"
        ? canSendInvoiceReminder(invoice.status)
        : canSendInvoiceEmail(invoice.status);
    if (
      !eligible ||
      (params.expectedScheduledJobId !== undefined &&
        !isCurrentInvoiceSchedule(invoice, params.expectedScheduledJobId))
    )
      return null;
    const [created] = await tx
      .insert(invoiceEmailDeliveries)
      .values({
        teamId: params.teamId,
        invoiceId: params.invoiceId,
        operationKey: params.operationKey,
        kind: params.kind,
        expectedScheduledJobId: params.expectedScheduledJobId,
        recipient: params.recipient,
        envelope: params.envelope,
        envelopeHash,
        activitySnapshot: params.activitySnapshot,
      })
      .onConflictDoNothing({
        target: [
          invoiceEmailDeliveries.teamId,
          invoiceEmailDeliveries.operationKey,
        ],
      })
      .returning();
    if (created) return created;
    const raced = await getInvoiceEmailDelivery(tx, params);
    if (!raced) throw new Error("Invoice email operation scope conflict");
    return raced;
  });
}

export type InvoiceEmailClaim =
  | { state: "claimed"; delivery: InvoiceEmailDelivery; leaseToken: string }
  | {
      state:
        | "accepted"
        | "completed"
        | "busy"
        | "stopped"
        | "missing"
        | "deferred";
      delivery: InvoiceEmailDelivery | null;
    };

/** Short transaction only; rendering, storage downloads and HTTP happen outside it. */
async function transitionInvoiceEmailDelivery(
  db: DatabaseOrTransaction,
  scope: InvoiceEmailDeliveryScope,
  mode: "claim" | "defer",
): Promise<InvoiceEmailClaim> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, scope.invoiceId),
          eq(invoices.teamId, scope.teamId),
        ),
      )
      .for("update");
    if (!invoice) return { state: "missing", delivery: null };
    const [row] = await tx
      .select()
      .from(invoiceEmailDeliveries)
      .where(scopeCondition(scope))
      .for("update");
    if (!row) return { state: "missing", delivery: null };
    if (row.status === "accepted" || row.status === "completed")
      return { state: row.status, delivery: row };
    if (["reconciliation", "canceled", "rejected"].includes(row.status))
      return { state: "stopped", delivery: row };
    // Read the clock AFTER acquiring the row lock. A target-list timestamp
    // evaluated before a lock wait could falsely look older than a just-written row.
    const clock = await tx.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const nowText = clock.rows[0]?.now ?? "";
    if (invoiceEmailClockIsUnsafe(row, nowText)) {
      const [stopped] = await tx
        .update(invoiceEmailDeliveries)
        .set({
          status: "reconciliation",
          lastError: "clock_anomaly",
          // A currently running request may still return a real acceptance.
          // Retain only its fence; no new claimant can send this stopped row.
          leaseToken: row.status === "sending" ? row.leaseToken : null,
          leaseExpiresAt: row.status === "sending" ? row.leaseExpiresAt : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(scopeCondition(scope))
        .returning();
      return { state: "stopped", delivery: stopped ?? row };
    }
    const now = new Date(nowText).getTime();
    if (row.leaseExpiresAt && new Date(row.leaseExpiresAt).getTime() > now)
      return { state: "busy", delivery: row };
    if (new Date(row.nextAttemptAt).getTime() > now)
      return { state: "busy", delivery: row };
    const eligible =
      row.kind === "reminder"
        ? canSendInvoiceReminder(invoice.status)
        : canSendInvoiceEmail(invoice.status);
    const scheduleMatches =
      row.expectedScheduledJobId === null ||
      isCurrentInvoiceSchedule(invoice, row.expectedScheduledJobId);
    const expired =
      row.firstAttemptAt !== null &&
      now - new Date(row.firstAttemptAt).getTime() >=
        INVOICE_EMAIL_REPLAY_WINDOW_MS;
    if (
      !eligible ||
      !scheduleMatches ||
      expired ||
      row.attempts >= INVOICE_EMAIL_MAX_ATTEMPTS
    ) {
      const status =
        row.firstAttemptAt === null && (!eligible || !scheduleMatches)
          ? "canceled"
          : "reconciliation";
      const [stopped] = await tx
        .update(invoiceEmailDeliveries)
        .set({
          status,
          lastError: expired
            ? "replay_window_expired"
            : !eligible || !scheduleMatches
              ? "invoice_changed"
              : "attempt_limit",
          // Expiration only ends exclusive sending authority. If no new
          // claimant replaced the lease, its in-flight request may still return
          // a real receipt after payment, rescheduling, or a replay limit.
          // Preserve that fence for acceptance only; this state cannot resend.
          leaseToken: row.status === "sending" ? row.leaseToken : null,
          leaseExpiresAt: row.status === "sending" ? row.leaseExpiresAt : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(scopeCondition(scope))
        .returning();
      return { state: "stopped", delivery: stopped ?? row };
    }
    if (mode === "defer") {
      // No external request can be made. Retain a previous request's fence so
      // a late real acceptance can still be recorded; never start/extend its
      // idempotency window or consume another sending attempt.
      const [deferred] = await tx
        .update(invoiceEmailDeliveries)
        .set({
          lastError: "configuration_unavailable",
          nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(scopeCondition(scope))
        .returning();
      return { state: "deferred", delivery: deferred ?? row };
    }
    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(invoiceEmailDeliveries)
      .set({
        status: "sending",
        leaseToken,
        leaseExpiresAt: sql`clock_timestamp() + ${INVOICE_EMAIL_LEASE_SECONDS} * interval '1 second'`,
        firstAttemptAt: sql`coalesce(${invoiceEmailDeliveries.firstAttemptAt}, clock_timestamp())`,
        attempts: sql`${invoiceEmailDeliveries.attempts} + 1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(scopeCondition(scope))
      .returning();
    if (!claimed) throw new Error("Invoice email claim disappeared");
    return { state: "claimed", delivery: claimed, leaseToken };
  });
}

export function claimInvoiceEmailDelivery(
  db: DatabaseOrTransaction,
  scope: InvoiceEmailDeliveryScope,
): Promise<InvoiceEmailClaim> {
  return transitionInvoiceEmailDelivery(db, scope, "claim");
}

/** Transport outages back off before a lease/attempt is acquired. The same
 * locked eligibility/clock/replay guards still run: missing credentials must
 * not hide a paid invoice, expired replay window or unsafe chronology. */
export function deferInvoiceEmailDelivery(
  db: DatabaseOrTransaction,
  scope: InvoiceEmailDeliveryScope,
): Promise<InvoiceEmailClaim> {
  return transitionInvoiceEmailDelivery(db, scope, "defer");
}

export async function recordInvoiceDeliveryOutcome(
  db: DatabaseOrTransaction,
  scope: InvoiceEmailDeliveryScope & { leaseToken: string },
  outcome:
    | { kind: "accepted"; messageId: string }
    | { kind: "retry" | "rejected" | "reconciliation"; code: string },
) {
  const common = {
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: sql`clock_timestamp()`,
  };
  const [row] = await db
    .update(invoiceEmailDeliveries)
    .set(
      outcome.kind === "accepted"
        ? {
            ...common,
            status: "accepted",
            providerMessageId: outcome.messageId,
            acceptedAt: sql`clock_timestamp()`,
            nextAttemptAt: sql`clock_timestamp()`,
            lastError: null,
          }
        : {
            ...common,
            status: outcome.kind === "retry" ? "pending" : outcome.kind,
            // Error code only, never provider error text, HTML or recipient details.
            lastError: outcome.code.slice(0, 80),
            nextAttemptAt: sql`clock_timestamp() + least(900, 30 * power(2, least(${invoiceEmailDeliveries.attempts}, 5))) * interval '1 second'`,
          },
    )
    .where(
      and(
        scopeCondition(scope),
        outcome.kind === "accepted"
          ? or(
              eq(invoiceEmailDeliveries.status, "sending"),
              and(
                eq(invoiceEmailDeliveries.status, "reconciliation"),
                inArray(invoiceEmailDeliveries.lastError, [
                  "clock_anomaly",
                  "invoice_changed",
                  "replay_window_expired",
                  "attempt_limit",
                ]),
              ),
            )
          : eq(invoiceEmailDeliveries.status, "sending"),
        eq(invoiceEmailDeliveries.leaseToken, scope.leaseToken),
      ),
    )
    .returning();
  return row ?? null;
}

/** Back off a poison local finalization without changing the accepted receipt
 * or using provider-attempt counters. This prevents recovery-batch starvation.
 */
export async function deferInvoiceEmailFinalization(
  db: DatabaseOrTransaction,
  scope: InvoiceEmailDeliveryScope,
) {
  await db
    .update(invoiceEmailDeliveries)
    .set({
      lastError: "finalization_retry",
      nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(scopeCondition(scope), eq(invoiceEmailDeliveries.status, "accepted")),
    );
}

/** A receipt, invoice timestamp/status and in-app activities are finalized once. */
export async function finalizeInvoiceEmailDelivery(
  db: DatabaseOrTransaction,
  scope: InvoiceEmailDeliveryScope,
) {
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.id, scope.invoiceId),
          eq(invoices.teamId, scope.teamId),
        ),
      )
      .for("update");
    if (!invoice) return null;
    const [row] = await tx
      .select()
      .from(invoiceEmailDeliveries)
      .where(scopeCondition(scope))
      .for("update");
    if (!row || row.status === "completed") return row ?? null;
    if (row.status !== "accepted" || !row.acceptedAt || !row.providerMessageId)
      throw new Error("Invoice email has no durable acceptance receipt");
    if (row.kind === "invoice")
      await recordInvoiceEmailAccepted(tx, {
        ...scope,
        recipient: row.recipient,
        acceptedAt: row.acceptedAt,
        ...(row.expectedScheduledJobId === null
          ? {}
          : { expectedScheduledJobId: row.expectedScheduledJobId }),
      });
    else
      await recordInvoiceReminderAccepted(tx, {
        ...scope,
        acceptedAt: row.acceptedAt,
      });
    // Removed/deleting members must not regain an activity. Recheck membership
    // in the same SQL INSERT; avoid a stale snapshot FK failure on deleted users.
    for (const activity of row.activitySnapshot) {
      await tx.execute(sql`
        insert into ${activities} (id, team_id, user_id, type, source, priority, group_id, metadata)
        select gen_random_uuid(), ${scope.teamId}::uuid, ${activity.userId}::uuid,
          ${row.kind === "invoice" ? "invoice_sent" : "invoice_reminder_sent"}::activity_type,
          'user'::activity_source, ${activity.priority}, ${row.id}::uuid, ${JSON.stringify(activity.metadata)}::jsonb
        where exists (
          select 1 from ${usersOnTeam} member join ${users} profile on member.user_id = profile.id
          where member.team_id = ${scope.teamId}::uuid and member.user_id = ${activity.userId}::uuid
            and profile.deletion_started_at is null
        )
      `);
    }
    const [completed] = await tx
      .update(invoiceEmailDeliveries)
      .set({
        status: "completed",
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
        envelope: null,
        activitySnapshot: [],
      })
      .where(scopeCondition(scope))
      .returning();
    return completed ?? null;
  });
}

/** Safe metadata only. Payloads/recipient addresses never enter Redis recovery jobs. */
export async function listRecoverableInvoiceEmailDeliveries(
  db: DatabaseOrTransaction,
  limit = 25,
) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing method, not a React hook.
  const primary = "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
  return primary
    .select({
      teamId: invoiceEmailDeliveries.teamId,
      invoiceId: invoiceEmailDeliveries.invoiceId,
      operationKey: invoiceEmailDeliveries.operationKey,
    })
    .from(invoiceEmailDeliveries)
    .where(
      and(
        or(
          and(
            eq(invoiceEmailDeliveries.status, "accepted"),
            or(
              sql`${invoiceEmailDeliveries.lastError} is distinct from 'finalization_retry'`,
              lte(invoiceEmailDeliveries.nextAttemptAt, sql`clock_timestamp()`),
            ),
          ),
          and(
            inArray(invoiceEmailDeliveries.status, ["pending", "sending"]),
            or(
              sql`clock_timestamp() < greatest(${invoiceEmailDeliveries.createdAt}, ${invoiceEmailDeliveries.updatedAt}, ${invoiceEmailDeliveries.firstAttemptAt})`,
              and(
                lte(
                  invoiceEmailDeliveries.nextAttemptAt,
                  sql`clock_timestamp()`,
                ),
                or(
                  isNull(invoiceEmailDeliveries.leaseExpiresAt),
                  lte(
                    invoiceEmailDeliveries.leaseExpiresAt,
                    sql`clock_timestamp()`,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(
      asc(invoiceEmailDeliveries.nextAttemptAt),
      asc(invoiceEmailDeliveries.createdAt),
    )
    .limit(Math.max(1, Math.min(100, Math.trunc(limit))));
}
