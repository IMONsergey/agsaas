import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import {
  NOTIFICATION_DISPATCH_LEASE_SECONDS,
  NOTIFICATION_DISPATCH_MAX_ATTEMPTS,
  NOTIFICATION_DISPATCH_MAX_PAYLOAD_BYTES,
  type NotificationDispatchKind,
  type NotificationDispatchOutcome,
} from "../notification-dispatch";
import { notificationDispatches } from "../schema";

export type NotificationDispatch = typeof notificationDispatches.$inferSelect;
export type NotificationDispatchScope = {
  teamId: string;
  operationKey: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function notificationDispatchOperationKey(
  kind: NotificationDispatchKind,
  sourceJobId: string,
): string {
  if (!sourceJobId || sourceJobId.length > 512)
    throw new Error("Invalid notification operation identity");
  return createHash("sha256").update(`${kind}\0${sourceJobId}`).digest("hex");
}

function whereScope(scope: NotificationDispatchScope) {
  return and(
    eq(notificationDispatches.teamId, scope.teamId),
    eq(notificationDispatches.operationKey, scope.operationKey),
  );
}

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}

export async function ensureNotificationDispatch(
  db: DatabaseOrTransaction,
  input: NotificationDispatchScope & {
    kind: NotificationDispatchKind;
    sourceJobId: string;
    payload: Record<string, unknown>;
  },
): Promise<NotificationDispatch> {
  const encoded = canonical(input.payload);
  if (
    Buffer.byteLength(encoded) > NOTIFICATION_DISPATCH_MAX_PAYLOAD_BYTES ||
    input.payload.teamId !== input.teamId
  )
    throw new Error("Invalid notification dispatch payload");
  if (
    input.operationKey !==
    notificationDispatchOperationKey(input.kind, input.sourceJobId)
  )
    throw new Error("Invalid notification dispatch identity");
  const payloadHash = createHash("sha256").update(encoded).digest("hex");
  const connection = primary(db);
  await connection
    .insert(notificationDispatches)
    .values({ ...input, payloadHash })
    .onConflictDoNothing({
      target: [
        notificationDispatches.teamId,
        notificationDispatches.operationKey,
      ],
    });
  const [row] = await connection
    .select()
    .from(notificationDispatches)
    .where(whereScope(input))
    .limit(1);
  if (
    !row ||
    row.kind !== input.kind ||
    row.sourceJobId !== input.sourceJobId ||
    row.payloadHash !== payloadHash
  )
    throw new Error("Notification dispatch scope or payload conflict");
  return row;
}

export type NotificationDispatchClaim =
  | { state: "claimed"; row: NotificationDispatch; token: string }
  | {
      state:
        | "pending"
        | "busy"
        | "completed"
        | "rejected"
        | "reconciliation"
        | "missing";
      row: NotificationDispatch | null;
    };

/** No HTTP while holding this transaction. Only a newly returned token permits
 * dispatch. An expired fence never becomes a fresh send automatically. */
export async function beginNotificationDispatch(
  db: DatabaseOrTransaction,
  scope: NotificationDispatchScope,
  ready: boolean,
): Promise<NotificationDispatchClaim> {
  return primary(db).transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(notificationDispatches)
      .where(whereScope(scope))
      .for("update");
    if (!row) return { state: "missing", row: null };
    if (
      row.status === "completed" ||
      row.status === "rejected" ||
      row.status === "reconciliation"
    )
      return { state: row.status, row };
    const clock = await tx.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const now = Date.parse(clock.rows[0]?.now ?? "");
    const chronological =
      Number.isFinite(now) &&
      [row.createdAt, row.updatedAt, row.startedAt]
        .filter((value): value is string => value !== null)
        .every(
          (value) =>
            Number.isFinite(Date.parse(value)) && Date.parse(value) <= now,
        ) &&
      Date.parse(row.updatedAt) >= Date.parse(row.createdAt) &&
      (!row.startedAt ||
        (Date.parse(row.startedAt) >= Date.parse(row.createdAt) &&
          Date.parse(row.updatedAt) >= Date.parse(row.startedAt))) &&
      Number.isFinite(Date.parse(row.nextAttemptAt));
    if (
      !chronological ||
      (row.status === "dispatching" &&
        (!row.leaseExpiresAt ||
          !Number.isFinite(Date.parse(row.leaseExpiresAt)) ||
          Date.parse(row.leaseExpiresAt) <= now))
    ) {
      const [stopped] = await tx
        .update(notificationDispatches)
        .set({
          status: "reconciliation",
          lastError: chronological ? "dispatch_interrupted" : "clock_anomaly",
          updatedAt: sql`clock_timestamp()`,
        })
        .where(whereScope(scope))
        .returning();
      return { state: "reconciliation", row: stopped ?? row };
    }
    if (row.status === "dispatching") return { state: "busy", row };
    if (Date.parse(row.nextAttemptAt) > now) return { state: "pending", row };
    if (!ready) {
      const [deferred] = await tx
        .update(notificationDispatches)
        .set({
          lastError: "configuration_unavailable",
          nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(whereScope(scope))
        .returning();
      return { state: "pending", row: deferred ?? row };
    }
    if (row.attempts >= NOTIFICATION_DISPATCH_MAX_ATTEMPTS) {
      const [stopped] = await tx
        .update(notificationDispatches)
        .set({
          status: "rejected",
          lastError: "attempt_limit",
          updatedAt: sql`clock_timestamp()`,
        })
        .where(whereScope(scope))
        .returning();
      return { state: "rejected", row: stopped ?? row };
    }
    const token = randomUUID();
    const [claimed] = await tx
      .update(notificationDispatches)
      .set({
        status: "dispatching",
        dispatchToken: token,
        leaseExpiresAt: sql`clock_timestamp() + ${NOTIFICATION_DISPATCH_LEASE_SECONDS} * interval '1 second'`,
        startedAt: sql`coalesce(${notificationDispatches.startedAt}, clock_timestamp())`,
        attempts: sql`${notificationDispatches.attempts} + 1`,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(whereScope(scope))
      .returning();
    if (!claimed) throw new Error("Notification dispatch disappeared");
    return { state: "claimed", row: claimed, token };
  });
}

export async function finishNotificationDispatch(
  db: DatabaseOrTransaction,
  scope: NotificationDispatchScope & { token: string },
  outcome: NotificationDispatchOutcome,
): Promise<NotificationDispatch | null> {
  if (
    ![
      outcome.activities,
      outcome.sent,
      outcome.skipped,
      outcome.failed,
      outcome.uncertain,
    ].every((count) => Number.isSafeInteger(count) && count >= 0) ||
    outcome.uncertain > outcome.failed ||
    !Array.isArray(outcome.providerMessageIds) ||
    outcome.providerMessageIds.length !== outcome.sent ||
    new Set(outcome.providerMessageIds).size !== outcome.sent ||
    outcome.providerMessageIds.some(
      (id) => typeof id !== "string" || !id.trim() || id.length > 256,
    )
  )
    throw new Error("Invalid notification acceptance receipt");
  const zeroAcceptance = outcome.sent === 0 && outcome.uncertain === 0;
  const retry =
    zeroAcceptance &&
    outcome.failed > 0 &&
    (outcome.retryable || outcome.reason === "configuration_unavailable");
  const status =
    outcome.failed === 0 && outcome.uncertain === 0
      ? "completed"
      : retry
        ? "pending"
        : zeroAcceptance
          ? "rejected"
          : "reconciliation";
  const [row] = await primary(db)
    .update(notificationDispatches)
    .set({
      status,
      outcome,
      lastError:
        status === "completed"
          ? null
          : (outcome.reason ??
            (status === "pending"
              ? "provider_rate_limit"
              : status === "reconciliation"
                ? "provider_acceptance_unconfirmed"
                : "provider_rejected")),
      nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'`,
      dispatchToken: null,
      leaseExpiresAt: null,
      ...(status === "completed" ? { payload: null } : {}),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        whereScope(scope),
        eq(notificationDispatches.dispatchToken, scope.token),
        status === "completed" && outcome.sent > 0
          ? inArray(notificationDispatches.status, [
              "dispatching",
              "reconciliation",
            ])
          : eq(notificationDispatches.status, "dispatching"),
      ),
    )
    .returning();
  return row ?? null;
}

export async function interruptNotificationDispatch(
  db: DatabaseOrTransaction,
  scope: NotificationDispatchScope & { token: string },
) {
  await primary(db)
    .update(notificationDispatches)
    .set({
      status: "reconciliation",
      lastError: "dispatch_interrupted",
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        whereScope(scope),
        eq(notificationDispatches.dispatchToken, scope.token),
        eq(notificationDispatches.status, "dispatching"),
      ),
    );
}

/** A stale business event may be canceled only before an external dispatch. */
export async function stopPendingNotificationDispatch(
  db: DatabaseOrTransaction,
  scope: NotificationDispatchScope,
) {
  const [row] = await primary(db)
    .update(notificationDispatches)
    .set({
      status: "rejected",
      lastError: "event_expired",
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(whereScope(scope), eq(notificationDispatches.status, "pending")))
    .returning();
  return row ?? null;
}

export async function listRecoverableNotificationDispatches(
  db: DatabaseOrTransaction,
  limit = 25,
) {
  return primary(db)
    .select()
    .from(notificationDispatches)
    .where(
      or(
        and(
          eq(notificationDispatches.status, "pending"),
          lte(notificationDispatches.nextAttemptAt, sql`clock_timestamp()`),
        ),
        and(
          eq(notificationDispatches.status, "dispatching"),
          or(
            lte(notificationDispatches.leaseExpiresAt, sql`clock_timestamp()`),
            isNull(notificationDispatches.leaseExpiresAt),
            gt(notificationDispatches.updatedAt, sql`clock_timestamp()`),
            gt(notificationDispatches.startedAt, sql`clock_timestamp()`),
          ),
        ),
      ),
    )
    .orderBy(asc(notificationDispatches.nextAttemptAt))
    .limit(Math.min(100, Math.max(1, limit)));
}

/** Team-scoped operational status intentionally excludes payload and receipts. */
export async function listNotificationDispatchStatus(
  db: DatabaseOrTransaction,
  teamId: string,
  limit = 50,
) {
  return primary(db)
    .select({
      id: notificationDispatches.id,
      kind: notificationDispatches.kind,
      status: notificationDispatches.status,
      attempts: notificationDispatches.attempts,
      nextAttemptAt: notificationDispatches.nextAttemptAt,
      lastError: notificationDispatches.lastError,
      updatedAt: notificationDispatches.updatedAt,
    })
    .from(notificationDispatches)
    .where(eq(notificationDispatches.teamId, teamId))
    .orderBy(desc(notificationDispatches.updatedAt))
    .limit(Math.min(100, Math.max(1, limit)));
}
