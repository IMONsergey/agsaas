import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client";

export type SupportRequestInput = {
  id: string;
  source: "website" | "dashboard";
  scopeKey: string;
  teamId?: string | null;
  userId?: string | null;
  email: string;
  fullName: string;
  subject: string;
  priority: "low" | "normal" | "high" | "urgent";
  product: string;
  message: string;
};
export class SupportRequestError extends Error {
  constructor(public readonly code: "CONFLICT" | "RATE_LIMITED") {
    super(code);
  }
}
function primary(db: Database) {
  const candidate = db as Database & {
    $primary?: Database;
    usePrimaryOnly?: () => Database;
  };
  return candidate.usePrimaryOnly?.() ?? candidate.$primary ?? db;
}
export async function submitSupportRequest(
  db: Database,
  input: SupportRequestInput,
) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.source,
        input.scopeKey,
        input.teamId ?? null,
        input.userId ?? null,
        input.email.toLowerCase(),
        input.fullName,
        input.subject,
        input.priority,
        input.product,
        input.message,
      ]),
    )
    .digest("hex");
  return primary(db).transaction(async (tx) => {
    // One daily lock makes replay and both admission budgets atomic across all API replicas.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('agsaas-support-admission',0))`,
    );
    const existing = (
      await tx.execute(
        sql`SELECT id,scope_key,payload_hash FROM public.support_requests WHERE id=${input.id}::uuid`,
      )
    ).rows[0];
    if (existing) {
      if (
        existing.scope_key !== input.scopeKey ||
        existing.payload_hash !== hash
      )
        throw new SupportRequestError("CONFLICT");
      return {
        id: input.id,
        accepted: true as const,
        status: "received" as const,
      };
    }
    const budget = (
      await tx.execute(sql`SELECT
     count(*) FILTER (WHERE scope_key=${input.scopeKey} AND created_at>now()-interval '1 hour')::int AS hourly,
     count(*) FILTER (WHERE scope_key=${input.scopeKey})::int AS daily,
     count(*)::int AS total
     FROM public.support_requests WHERE created_at>now()-interval '24 hours'`)
    ).rows[0];
    if (
      Number(budget?.hourly) >= 10 ||
      Number(budget?.daily) >= 30 ||
      Number(budget?.total) >= 1000
    )
      throw new SupportRequestError("RATE_LIMITED");
    await tx.execute(sql`INSERT INTO public.support_requests
     (id,source,scope_key,payload_hash,team_id,user_id,email,full_name,subject,priority,product,message)
     VALUES (${input.id}::uuid,${input.source},${input.scopeKey},${hash},
       ${input.teamId ?? null}::uuid,${input.userId ?? null}::uuid,${input.email.toLowerCase()},
       ${input.fullName},${input.subject},${input.priority},${input.product},${input.message})`);
    return {
      id: input.id,
      accepted: true as const,
      status: "received" as const,
    };
  });
}
export async function getOwnSupportRequests(
  db: Database,
  teamId: string,
  userId: string,
) {
  return (
    await primary(
      db,
    ).execute(sql`SELECT id,subject,priority,product,status,created_at::text AS "createdAt"
   FROM public.support_requests WHERE team_id=${teamId}::uuid AND user_id=${userId}::uuid
   ORDER BY created_at DESC,id DESC LIMIT 50`)
  ).rows as unknown as Array<{
    id: string;
    subject: string;
    priority: string;
    product: string;
    status: string;
    createdAt: string;
  }>;
}
