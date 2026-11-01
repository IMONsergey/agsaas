import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import {
  type FinancialJobName,
  type FinancialJobStatus,
  financialJobOperationKey,
  financialJobQueues,
  financialRequestHash,
} from "../financial-job";
import { financialJobDispatches } from "../schema";

export type FinancialJobDispatch = typeof financialJobDispatches.$inferSelect;
type Scope = { id: string; teamId: string };

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}

/** Call inside the same transaction as the business write. No Redis call here. */
export async function ensureFinancialJobDispatch(
  db: DatabaseOrTransaction,
  input: {
    teamId: string;
    jobName: FinancialJobName;
    source: string;
    payload: Record<string, unknown>;
  },
) {
  const queueName = financialJobQueues[input.jobName];
  const operationKey = financialJobOperationKey(input.jobName, input.source);
  if (
    !queueName ||
    input.payload.teamId !== input.teamId ||
    Buffer.byteLength(JSON.stringify(input.payload)) > 65536
  )
    throw new Error("Invalid financial job payload");
  const payloadHash = financialRequestHash(input.payload);
  const connection = primary(db);
  await connection
    .insert(financialJobDispatches)
    .values({
      teamId: input.teamId,
      jobName: input.jobName,
      queueName,
      operationKey,
      payload: input.payload,
      payloadHash,
    })
    .onConflictDoNothing({
      target: [
        financialJobDispatches.teamId,
        financialJobDispatches.operationKey,
      ],
    });
  const [row] = await connection
    .select()
    .from(financialJobDispatches)
    .where(
      and(
        eq(financialJobDispatches.teamId, input.teamId),
        eq(financialJobDispatches.operationKey, operationKey),
      ),
    )
    .limit(1);
  if (!row || row.jobName !== input.jobName || row.payloadHash !== payloadHash)
    throw new Error("Financial job identity or payload conflict");
  return row;
}

export async function listRecoverableFinancialJobs(
  db: DatabaseOrTransaction,
  limit = 25,
) {
  return primary(db)
    .select()
    .from(financialJobDispatches)
    .where(
      and(
        inArray(financialJobDispatches.status, ["pending", "accepted"]),
        lte(financialJobDispatches.nextAttemptAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(asc(financialJobDispatches.nextAttemptAt))
    .limit(Math.min(100, Math.max(1, limit)));
}

/** The short SQL claim only bounds polling. Replaying Queue.add is deliberately safe. */
export async function claimFinancialJob(
  db: DatabaseOrTransaction,
  scope: Scope,
) {
  const [row] = await primary(db)
    .update(financialJobDispatches)
    .set({
      nextAttemptAt: sql`clock_timestamp() + interval '1 minute'`,
      attempts: sql`${financialJobDispatches.attempts} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(financialJobDispatches.id, scope.id),
        eq(financialJobDispatches.teamId, scope.teamId),
        inArray(financialJobDispatches.status, ["pending", "accepted"]),
        lte(financialJobDispatches.nextAttemptAt, sql`clock_timestamp()`),
      ),
    )
    .returning();
  return row ?? null;
}

export async function recordFinancialJobState(
  db: DatabaseOrTransaction,
  scope: Scope,
  status: Exclude<FinancialJobStatus, "pending">,
) {
  await primary(db)
    .update(financialJobDispatches)
    .set({
      status,
      lastError: status === "failed" ? "job_failed" : null,
      nextAttemptAt: sql`clock_timestamp() + interval '1 minute'`,
      updatedAt: sql`clock_timestamp()`,
      ...(status === "completed" ? { payload: null } : {}),
    })
    .where(
      and(
        eq(financialJobDispatches.id, scope.id),
        eq(financialJobDispatches.teamId, scope.teamId),
        inArray(financialJobDispatches.status, ["pending", "accepted"]),
      ),
    );
}

export async function deferFinancialJob(
  db: DatabaseOrTransaction,
  scope: Scope,
) {
  await primary(db)
    .update(financialJobDispatches)
    .set({
      nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'`,
      lastError: "queue_unavailable",
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(financialJobDispatches.id, scope.id),
        eq(financialJobDispatches.teamId, scope.teamId),
        inArray(financialJobDispatches.status, ["pending", "accepted"]),
      ),
    );
}
