import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { customers } from "../schema";
import {
  type CustomerEnrichmentUpdateData,
  updateCustomerEnrichment,
} from "./customer-enrichment";

export type EnrichmentIdentity = { customerId: string; teamId: string };
export type EnrichmentOperation = EnrichmentIdentity & {
  operationId: string;
  attemptCount: number;
};
export type EnrichmentLease = EnrichmentOperation & { attemptId: string };

function primary(db: DatabaseOrTransaction): DatabaseOrTransaction {
  const connection = db as DatabaseOrTransaction & {
    usePrimaryOnly?: () => DatabaseOrTransaction;
    $primary?: DatabaseOrTransaction;
  };
  return connection.usePrimaryOnly?.() ?? connection.$primary ?? db;
}

async function lockCustomer(
  db: DatabaseOrTransaction,
  identity: EnrichmentIdentity,
) {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.id, identity.customerId),
        eq(customers.teamId, identity.teamId),
      ),
    )
    .for("update");
  return rows.length === 1;
}

/** SQL is the durable intent. Redis submission is only a delivery optimization. */
export async function requestCustomerEnrichment(
  db: DatabaseOrTransaction,
  identity: EnrichmentIdentity,
): Promise<EnrichmentOperation | null> {
  return primary(db).transaction(async (tx) => {
    if (!(await lockCustomer(tx, identity))) return null;
    const existing =
      await tx.execute(sql`SELECT id AS "operationId", attempt_count AS "attemptCount"
    FROM public.customer_enrichment_operations WHERE customer_id=${identity.customerId}::uuid
    AND team_id=${identity.teamId}::uuid AND is_current AND status IN ('queued','processing')`);
    if (existing.rows[0])
      return { ...identity, ...existing.rows[0] } as EnrichmentOperation;
    await tx.execute(sql`UPDATE public.customer_enrichment_operations SET is_current=false,updated_at=now()
    WHERE customer_id=${identity.customerId}::uuid AND team_id=${identity.teamId}::uuid AND is_current`);
    const operationId = randomUUID();
    await tx.execute(sql`INSERT INTO public.customer_enrichment_operations(id,customer_id,team_id)
    VALUES(${operationId}::uuid,${identity.customerId}::uuid,${identity.teamId}::uuid)`);
    await tx
      .update(customers)
      .set({ enrichmentStatus: "pending" })
      .where(
        and(
          eq(customers.id, identity.customerId),
          eq(customers.teamId, identity.teamId),
        ),
      );
    return { ...identity, operationId, attemptCount: 0 };
  });
}

export async function cancelCustomerEnrichment(
  db: DatabaseOrTransaction,
  identity: EnrichmentIdentity,
): Promise<boolean> {
  return primary(db).transaction(async (tx) => {
    if (!(await lockCustomer(tx, identity))) return false;
    const cancelled =
      await tx.execute(sql`UPDATE public.customer_enrichment_operations SET status='cancelled',is_current=false,lease_expires_at=NULL,updated_at=now()
    WHERE customer_id=${identity.customerId}::uuid AND team_id=${identity.teamId}::uuid AND is_current AND status IN ('queued','processing') RETURNING id`);
    if (cancelled.rows.length === 0) return false;
    await tx
      .update(customers)
      .set({ enrichmentStatus: null })
      .where(
        and(
          eq(customers.id, identity.customerId),
          eq(customers.teamId, identity.teamId),
        ),
      );
    return true;
  });
}

export async function claimCustomerEnrichment(
  db: DatabaseOrTransaction,
  operation: EnrichmentIdentity & { operationId: string },
): Promise<EnrichmentLease | null> {
  return primary(db).transaction(async (tx) => {
    if (!(await lockCustomer(tx, operation))) return null;
    const result =
      await tx.execute(sql`SELECT attempt_count AS "attemptCount" FROM public.customer_enrichment_operations
    WHERE id=${operation.operationId}::uuid AND customer_id=${operation.customerId}::uuid AND team_id=${operation.teamId}::uuid
    AND is_current AND ((status='queued' AND next_attempt_at<=now()) OR (status='processing' AND lease_expires_at<=now())) FOR UPDATE`);
    const current = result.rows[0] as { attemptCount: number } | undefined;
    if (!current) return null;
    if (current.attemptCount >= 3) {
      await tx.execute(
        sql`UPDATE public.customer_enrichment_operations SET status='failed',error_code='attempts_exhausted',updated_at=now() WHERE id=${operation.operationId}::uuid`,
      );
      await tx
        .update(customers)
        .set({ enrichmentStatus: "failed" })
        .where(eq(customers.id, operation.customerId));
      return null;
    }
    const attemptId = randomUUID();
    await tx.execute(sql`UPDATE public.customer_enrichment_operations SET status='processing',attempt_id=${attemptId}::uuid,
    attempt_count=attempt_count+1,lease_expires_at=now()+interval '60 seconds',updated_at=now(),error_code=NULL
    WHERE id=${operation.operationId}::uuid`);
    await tx
      .update(customers)
      .set({ enrichmentStatus: "processing" })
      .where(eq(customers.id, operation.customerId));
    return { ...operation, attemptId, attemptCount: current.attemptCount + 1 };
  });
}

export async function isCustomerEnrichmentCurrent(
  db: DatabaseOrTransaction,
  lease: EnrichmentLease,
): Promise<boolean> {
  const result = await primary(
    db,
  ).execute(sql`SELECT 1 FROM public.customer_enrichment_operations o
  JOIN public.customers c ON c.id=o.customer_id AND c.team_id=o.team_id
  WHERE o.id=${lease.operationId}::uuid AND o.customer_id=${lease.customerId}::uuid AND o.team_id=${lease.teamId}::uuid
  AND o.attempt_id=${lease.attemptId}::uuid AND o.is_current AND o.status='processing' AND o.lease_expires_at>now()`);
  return result.rows.length === 1;
}

/** Both the application of fields and completion marker are fenced in one transaction. */
export async function completeCustomerEnrichment(
  db: DatabaseOrTransaction,
  lease: EnrichmentLease,
  data: CustomerEnrichmentUpdateData,
): Promise<boolean> {
  return primary(db).transaction(async (tx) => {
    if (
      !(await lockCustomer(tx, lease)) ||
      !(await isCustomerEnrichmentCurrent(tx, lease))
    )
      return false;
    await updateCustomerEnrichment(tx, {
      customerId: lease.customerId,
      teamId: lease.teamId,
      data,
    });
    await tx.execute(sql`UPDATE public.customer_enrichment_operations SET status='completed',lease_expires_at=NULL,updated_at=now()
    WHERE id=${lease.operationId}::uuid AND attempt_id=${lease.attemptId}::uuid`);
    return true;
  });
}

export async function failCustomerEnrichment(
  db: DatabaseOrTransaction,
  lease: EnrichmentLease,
  code: "provider_error" | "timeout" | "provider_not_configured",
): Promise<boolean> {
  return primary(db).transaction(async (tx) => {
    if (
      !(await lockCustomer(tx, lease)) ||
      !(await isCustomerEnrichmentCurrent(tx, lease))
    )
      return false;
    const retry = code !== "provider_not_configured" && lease.attemptCount < 3;
    await tx.execute(sql`UPDATE public.customer_enrichment_operations SET status=${retry ? "queued" : "failed"},error_code=${code},
    lease_expires_at=NULL,next_attempt_at=now()+interval '1 minute',updated_at=now()
    WHERE id=${lease.operationId}::uuid AND attempt_id=${lease.attemptId}::uuid`);
    await tx
      .update(customers)
      .set({ enrichmentStatus: retry ? "pending" : "failed" })
      .where(eq(customers.id, lease.customerId));
    return true;
  });
}

export async function listPendingCustomerEnrichments(
  db: DatabaseOrTransaction,
  limit = 50,
): Promise<EnrichmentOperation[]> {
  const result = await primary(
    db,
  ).execute(sql`SELECT o.id AS "operationId",o.customer_id AS "customerId",o.team_id AS "teamId",o.attempt_count AS "attemptCount"
  FROM public.customer_enrichment_operations o JOIN public.customers c ON c.id=o.customer_id AND c.team_id=o.team_id
  WHERE o.is_current AND ((o.status='queued' AND o.next_attempt_at<=now()) OR (o.status='processing' AND o.lease_expires_at<=now()))
  ORDER BY o.requested_at LIMIT ${Math.max(1, Math.min(100, limit))}`);
  return result.rows as EnrichmentOperation[];
}
