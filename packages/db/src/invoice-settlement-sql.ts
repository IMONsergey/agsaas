import { sql } from "drizzle-orm";
import { invoices } from "./schema";
// Convert integer journal units through the immutable original invoice amount.
// This also retains the established ISK/UGX and three-decimal wire representation.
export const invoiceReceivedAmount = sql`coalesce((select (s.projection->>'netSettledMinor')::numeric * ${invoices.amount} /
 nullif((s.projection->>'invoiceAmountMinor')::numeric,0) from invoice_settlement_state s
 where s.invoice_id=${invoices.id} and s.team_id=${invoices.teamId}),case when ${invoices.status}='paid' then ${invoices.amount} else 0 end)`;
export const invoiceOutstandingAmount = sql`case when ${invoices.status} in ('unpaid','overdue') then coalesce((select
 (s.projection->>'balanceMinor')::numeric * ${invoices.amount}/nullif((s.projection->>'invoiceAmountMinor')::numeric,0)
 from invoice_settlement_state s where s.invoice_id=${invoices.id} and s.team_id=${invoices.teamId}),${invoices.amount}) else 0 end`;
