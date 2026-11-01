import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@midday/encryption";
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
import {
  BANK_CLEANUP_LEASE_SECONDS,
  BANK_CLEANUP_MAX_ATTEMPTS,
  type BankCleanupOutcome,
  type BankCleanupTarget,
} from "../bank-connection-cleanup";
import type { DatabaseOrTransaction, TransactionClient } from "../client";
import { bankConnectionCleanups, bankConnections } from "../schema";

export type BankConnectionCleanup = typeof bankConnectionCleanups.$inferSelect;
type Connection = Pick<
  typeof bankConnections.$inferSelect,
  "id" | "teamId" | "provider" | "referenceId" | "accessToken"
>;

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}

/** Call only inside the transaction which deletes the locked source row. */
export async function retainBankConnectionCleanup(
  tx: TransactionClient,
  connection: Connection,
) {
  if (!connection.teamId)
    throw new Error("Bank cleanup requires a team identity");
  const payload = JSON.stringify({
    version: 1,
    connectionId: connection.id,
    teamId: connection.teamId,
    provider: connection.provider,
    referenceId: connection.referenceId,
    accessToken: connection.accessToken,
  });
  if (Buffer.byteLength(payload) > 32768)
    throw new Error("Bank cleanup payload exceeds the retention limit");
  let encryptedPayload: string;
  try {
    encryptedPayload = encrypt(payload);
  } catch {
    throw new Error("Bank provider cleanup cannot be retained securely");
  }
  const [row] = await tx
    .insert(bankConnectionCleanups)
    .values({
      teamId: connection.teamId,
      connectionId: connection.id,
      provider: connection.provider,
      encryptedPayload,
    })
    .returning({
      id: bankConnectionCleanups.id,
      status: bankConnectionCleanups.status,
    });
  if (!row) throw new Error("Bank cleanup intent was not retained");
  return row;
}

/** The caller holds the parent team lock, preventing a late FK insert. */
export async function retainTeamBankConnectionCleanups(
  tx: TransactionClient,
  teamId: string,
) {
  const connections = await tx
    .select({
      id: bankConnections.id,
      teamId: bankConnections.teamId,
      provider: bankConnections.provider,
      referenceId: bankConnections.referenceId,
      accessToken: bankConnections.accessToken,
    })
    .from(bankConnections)
    .where(eq(bankConnections.teamId, teamId))
    .orderBy(asc(bankConnections.id))
    .for("update");
  for (const connection of connections)
    await retainBankConnectionCleanup(tx, connection);
  return connections.length;
}

/** Bound identity is authenticated by AES-GCM; ciphertext cannot be moved to
 * another connection/team/provider and then used by a different cleanup. */
export function openBankConnectionCleanup(
  row: BankConnectionCleanup,
): BankCleanupTarget {
  try {
    if (!row.encryptedPayload) throw new Error("Missing payload");
    const value = JSON.parse(decrypt(row.encryptedPayload));
    const nullableString = (input: unknown) =>
      input === null || typeof input === "string";
    if (
      !value ||
      value.version !== 1 ||
      value.connectionId !== row.connectionId ||
      value.teamId !== row.teamId ||
      value.provider !== row.provider ||
      !nullableString(value.referenceId) ||
      !nullableString(value.accessToken)
    )
      throw new Error("Invalid bound payload");
    return {
      provider: value.provider,
      referenceId: value.referenceId,
      accessToken: value.accessToken,
    };
  } catch {
    throw new Error("Bank cleanup credentials are unavailable");
  }
}

export async function getBankConnectionCleanup(
  db: DatabaseOrTransaction,
  id: string,
) {
  const [row] = await primary(db)
    .select()
    .from(bankConnectionCleanups)
    .where(eq(bankConnectionCleanups.id, id))
    .limit(1);
  return row ?? null;
}

export async function getBankConnectionCleanupStatus(
  db: DatabaseOrTransaction,
  connectionId: string,
  teamId: string,
) {
  const [row] = await primary(db)
    .select({
      id: bankConnectionCleanups.id,
      status: bankConnectionCleanups.status,
    })
    .from(bankConnectionCleanups)
    .where(
      and(
        eq(bankConnectionCleanups.connectionId, connectionId),
        eq(bankConnectionCleanups.teamId, teamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type BankCleanupClaim =
  | { state: "claimed"; row: BankConnectionCleanup; token: string }
  | {
      state: "pending" | "busy" | "completed" | "reconciliation" | "missing";
      row: BankConnectionCleanup | null;
    };

/** No provider request while holding SQL locks. A crash/expired lease is an
 * ambiguous revoke; recovery preserves the fence and never blindly repeats. */
export async function beginBankConnectionCleanup(
  db: DatabaseOrTransaction,
  id: string,
  ready: boolean,
): Promise<BankCleanupClaim> {
  return primary(db).transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(bankConnectionCleanups)
      .where(eq(bankConnectionCleanups.id, id))
      .for("update");
    if (!row) return { state: "missing", row: null };
    if (row.status === "completed" || row.status === "reconciliation")
      return { state: row.status, row };
    const result = await tx.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const now = Date.parse(result.rows[0]?.now ?? "");
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
      (row.status === "processing" &&
        (!row.leaseExpiresAt ||
          Date.parse(row.leaseExpiresAt) <= now ||
          !Number.isFinite(Date.parse(row.leaseExpiresAt))))
    ) {
      const [stopped] = await tx
        .update(bankConnectionCleanups)
        .set({
          status: "reconciliation",
          lastError: chronological ? "dispatch_interrupted" : "clock_anomaly",
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(bankConnectionCleanups.id, id))
        .returning();
      return { state: "reconciliation", row: stopped ?? row };
    }
    if (row.status === "processing") return { state: "busy", row };
    if (Date.parse(row.nextAttemptAt) > now) return { state: "pending", row };
    if (!ready) {
      const [deferred] = await tx
        .update(bankConnectionCleanups)
        .set({
          lastError: "configuration_unavailable",
          nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(bankConnectionCleanups.id, id))
        .returning();
      return { state: "pending", row: deferred ?? row };
    }
    if (row.attempts >= BANK_CLEANUP_MAX_ATTEMPTS) {
      const [stopped] = await tx
        .update(bankConnectionCleanups)
        .set({
          status: "reconciliation",
          lastError: "attempt_limit",
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(bankConnectionCleanups.id, id))
        .returning();
      return { state: "reconciliation", row: stopped ?? row };
    }
    const token = randomUUID();
    const [claimed] = await tx
      .update(bankConnectionCleanups)
      .set({
        status: "processing",
        attempts: sql`${bankConnectionCleanups.attempts} + 1`,
        dispatchToken: token,
        startedAt: sql`coalesce(${bankConnectionCleanups.startedAt}, clock_timestamp())`,
        leaseExpiresAt: sql`clock_timestamp() + ${BANK_CLEANUP_LEASE_SECONDS} * interval '1 second'`,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(bankConnectionCleanups.id, id))
      .returning();
    if (!claimed) throw new Error("Bank cleanup intent disappeared");
    return { state: "claimed", row: claimed, token };
  });
}

export async function finishBankConnectionCleanup(
  db: DatabaseOrTransaction,
  id: string,
  token: string,
  outcome: BankCleanupOutcome,
) {
  const [row] = await primary(db)
    .update(bankConnectionCleanups)
    .set({
      status: outcome.status,
      lastError: outcome.status === "completed" ? null : outcome.reason,
      ...(outcome.status === "completed"
        ? { encryptedPayload: null, completedAt: sql`clock_timestamp()` }
        : {}),
      nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'`,
      // A late definitive success may settle the same ambiguous fence.
      ...(outcome.status !== "reconciliation"
        ? { dispatchToken: null, leaseExpiresAt: null }
        : {}),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(bankConnectionCleanups.id, id),
        eq(bankConnectionCleanups.dispatchToken, token),
        outcome.status === "completed"
          ? inArray(bankConnectionCleanups.status, [
              "processing",
              "reconciliation",
            ])
          : eq(bankConnectionCleanups.status, "processing"),
      ),
    )
    .returning();
  return row ?? null;
}

export async function interruptBankConnectionCleanup(
  db: DatabaseOrTransaction,
  id: string,
  token: string,
) {
  await primary(db)
    .update(bankConnectionCleanups)
    .set({
      status: "reconciliation",
      lastError: "dispatch_interrupted",
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(bankConnectionCleanups.id, id),
        eq(bankConnectionCleanups.dispatchToken, token),
        eq(bankConnectionCleanups.status, "processing"),
      ),
    );
}

/** Only IDs leave SQL recovery; credentials never enter the queue or logs. */
export async function listRecoverableBankConnectionCleanups(
  db: DatabaseOrTransaction,
  limit = 10,
) {
  return primary(db)
    .select({ id: bankConnectionCleanups.id })
    .from(bankConnectionCleanups)
    .where(
      or(
        and(
          eq(bankConnectionCleanups.status, "pending"),
          lte(bankConnectionCleanups.nextAttemptAt, sql`clock_timestamp()`),
        ),
        and(
          eq(bankConnectionCleanups.status, "processing"),
          or(
            lte(bankConnectionCleanups.leaseExpiresAt, sql`clock_timestamp()`),
            isNull(bankConnectionCleanups.leaseExpiresAt),
            gt(bankConnectionCleanups.updatedAt, sql`clock_timestamp()`),
            gt(bankConnectionCleanups.startedAt, sql`clock_timestamp()`),
          ),
        ),
      ),
    )
    .orderBy(asc(bankConnectionCleanups.nextAttemptAt))
    .limit(Math.min(100, Math.max(1, limit)));
}

/** Public projection for an existing team; no provider reference or secret. */
export async function listBankConnectionCleanupStatus(
  db: DatabaseOrTransaction,
  teamId: string,
) {
  return primary(db)
    .select({
      id: bankConnectionCleanups.id,
      connectionId: bankConnectionCleanups.connectionId,
      provider: bankConnectionCleanups.provider,
      status: bankConnectionCleanups.status,
      attempts: bankConnectionCleanups.attempts,
      nextAttemptAt: bankConnectionCleanups.nextAttemptAt,
      lastError: bankConnectionCleanups.lastError,
      updatedAt: bankConnectionCleanups.updatedAt,
    })
    .from(bankConnectionCleanups)
    .where(eq(bankConnectionCleanups.teamId, teamId))
    .orderBy(desc(bankConnectionCleanups.updatedAt))
    .limit(100);
}
