import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import type {
  InvoiceRefundRequestState,
  RefundProviderStatus,
} from "../invoice-refund-request";

/** The row remains a money fence independently of the cached settlement projection. */
export async function getUnresolvedInvoiceRefundRequest(
  db: DatabaseOrTransaction,
  input: { invoiceId: string; teamId: string },
) {
  const result = await db.execute<{
    requestId: string;
    state: InvoiceRefundRequestState;
    refundStatus: RefundProviderStatus | null;
    amountMinor: string;
    currency: string;
    createdAt: string;
    knownResource: boolean;
  }>(sql`SELECT id AS "requestId",state,provider_status AS "refundStatus",refund_amount_minor::text AS "amountMinor",currency,
    created_at::text AS "createdAt",provider_refund_id IS NOT NULL AS "knownResource"
    FROM public.invoice_refund_requests WHERE invoice_id=${input.invoiceId}::uuid AND team_id=${input.teamId}::uuid
      AND state NOT IN ('settled','failed') ORDER BY created_at,id LIMIT 1`);
  return result.rows[0] ?? null;
}
