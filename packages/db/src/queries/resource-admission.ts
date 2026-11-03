import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { appendSecurityAuditEvent } from "./security-audit";

export class ResourceBudgetExceededError extends Error {
  readonly retryAfterSeconds = 60;
  constructor() {
    super("This workspace is busy. Retry shortly.");
    this.name = "ResourceBudgetExceededError";
  }
}
const primary = (db: DatabaseOrTransaction) =>
  // biome-ignore lint/correctness/useHookAtTopLevel: Drizzle primary routing is not a React hook.
  "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
function identifier(value: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value))
    throw new Error("Invalid admission identity");
  return value.toLowerCase();
}

/** Fixed one-minute budgets are atomic across API replicas; they are not billing entitlements. */
export async function consumeRequestBudget(
  db: DatabaseOrTransaction,
  input: { userId: string; teamId?: string | null; cost?: number },
) {
  const cost = input.cost ?? 1;
  if (!Number.isInteger(cost) || cost < 1 || cost > 100)
    throw new Error("Invalid admission cost");
  const budgets = [{ key: `user:${identifier(input.userId)}`, limit: 600 }];
  if (input.teamId)
    budgets.push({ key: `team:${identifier(input.teamId)}`, limit: 2400 });
  budgets.sort((a, b) => a.key.localeCompare(b.key));
  await primary(db).transaction(async (tx) => {
    for (const budget of budgets) {
      const result =
        await tx.execute(sql`INSERT INTO public.request_resource_budgets(bucket, window_start, used)
        VALUES (${budget.key}, date_trunc('minute', clock_timestamp()), ${cost})
        ON CONFLICT (bucket) DO UPDATE SET window_start = GREATEST(request_resource_budgets.window_start, EXCLUDED.window_start),
          used = CASE WHEN request_resource_budgets.window_start < EXCLUDED.window_start THEN EXCLUDED.used ELSE request_resource_budgets.used + EXCLUDED.used END
        WHERE request_resource_budgets.window_start < EXCLUDED.window_start OR request_resource_budgets.used + EXCLUDED.used <= ${budget.limit}
        RETURNING bucket`);
      if (!result.rows.length) throw new ResourceBudgetExceededError();
    }
  });
}

/** Durable active tickets never expire while a worker may still be running.
 * No connection is held across work. A hard crash requires confirmed process-stop reconciliation.
 * This intentionally fails closed after an ambiguous crash rather than overcommitting memory. */
export async function withHeavyJobAdmission<T>(
  db: DatabaseOrTransaction,
  input: {
    teamId: string;
    userId?: string;
    jobKey: string;
    ownerRunId: string;
  },
  work: () => Promise<T>,
): Promise<T> {
  identifier(input.teamId);
  identifier(input.ownerRunId);
  if (input.userId) identifier(input.userId);
  const id = randomUUID(),
    jobHash = createHash("sha256").update(input.jobKey).digest("hex");
  await primary(db).transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(100000, 1)`);
    const counts = await tx.execute<{
      all: number;
      team: number;
      actor: number;
      sameJob: number;
    }>(sql`SELECT count(*)::int AS "all",
      count(*) FILTER (WHERE team_id = ${input.teamId}::uuid)::int AS team,
      count(*) FILTER (WHERE user_id = ${input.userId ?? null}::uuid)::int AS actor,
      count(*) FILTER (WHERE job_hash = ${jobHash})::int AS "sameJob" FROM public.heavy_job_admissions`);
    const count = counts.rows[0]!;
    if (
      count.all >= 4 ||
      count.team >= 2 ||
      (input.userId && count.actor >= 1) ||
      count.sameJob > 0
    )
      throw new ResourceBudgetExceededError();
    await tx.execute(
      sql`INSERT INTO public.heavy_job_admissions(id, team_id, user_id, owner_run_id, job_hash) VALUES (${id}::uuid, ${input.teamId}::uuid, ${input.userId ?? null}::uuid, ${input.ownerRunId}::uuid, ${jobHash})`,
    );
  });
  try {
    return await work();
  } finally {
    // A failed release retains a ticket. The reconciler must not guess that work stopped.
    await primary(db).execute(
      sql`DELETE FROM public.heavy_job_admissions WHERE id = ${id}::uuid AND owner_run_id = ${input.ownerRunId}::uuid`,
    );
  }
}

/** Operator-only utility; never exposed to browser/MCP. Confirm the worker process is stopped first. */
export async function reconcileStoppedWorkerAdmissions(
  db: DatabaseOrTransaction,
  input: { ownerRunId: string; evidenceReference: string },
) {
  identifier(input.ownerRunId);
  if (!/^[A-Z0-9][A-Z0-9._:-]{5,127}$/i.test(input.evidenceReference))
    throw new Error("Operational evidence reference is required");
  return primary(db).transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(100000, 1)`);
    const removed = await tx.execute<{
      id: string;
      teamId: string;
      userId: string | null;
    }>(
      sql`DELETE FROM public.heavy_job_admissions WHERE owner_run_id = ${input.ownerRunId}::uuid RETURNING id, team_id AS "teamId", user_id AS "userId"`,
    );
    for (const row of removed.rows)
      await appendSecurityAuditEvent(tx, {
        teamId: row.teamId,
        actorUserId: row.userId,
        operation: "resource.reconcile",
        targetType: "resource_ticket",
        targetId: row.id,
        metadata: { reason: "operator_confirmed_stopped" },
      });
    await tx.execute(
      sql`INSERT INTO public.resource_admission_reconciliations(owner_run_id, evidence_reference, released_count) VALUES (${input.ownerRunId}::uuid, ${input.evidenceReference}, ${removed.rows.length})`,
    );
    return removed.rows.length;
  });
}

export async function pruneRequestBudgets(db: DatabaseOrTransaction) {
  await primary(db).execute(
    sql`DELETE FROM public.request_resource_budgets WHERE bucket IN (SELECT bucket FROM public.request_resource_budgets WHERE window_start < now() - interval '2 days' LIMIT 1000)`,
  );
}
