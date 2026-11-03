import type { DatabaseOrTransaction } from "@midday/db/client";
import { invoiceRefundRequestView } from "@midday/db/invoice-refund-request";
import {
  applyInvoiceRefundResource,
  claimInvoiceRefundDispatch,
  getInvoiceRefundRequestPlan,
  markInvoiceRefundDispatchUnknown,
  prepareInvoiceRefundRequest,
  retainInvoiceRefundResource,
} from "@midday/db/queries/invoice-refund-requests";
import {
  type DurableRefundProvider,
  runInvoiceRefundRequest,
} from "./invoice-refund-engine";

type Scope = { invoiceId: string; teamId: string; actorId: string };
function run(
  db: DatabaseOrTransaction,
  provider: DurableRefundProvider,
  input: Scope & { requestId: string },
) {
  return runInvoiceRefundRequest(provider, {
    load: () => getInvoiceRefundRequestPlan(db, input),
    claim: (revision) => claimInvoiceRefundDispatch(db, { ...input, revision }),
    retain: (revision, resource) =>
      retainInvoiceRefundResource(db, { ...input, revision, resource }),
    apply: (revision, resource) =>
      applyInvoiceRefundResource(db, { ...input, revision, resource }),
    unknown: (claimToken) =>
      markInvoiceRefundDispatchUnknown(db, { ...input, claimToken }),
    view: async () =>
      invoiceRefundRequestView(
        (await getInvoiceRefundRequestPlan(db, input)).request,
      ),
  });
}
export async function requestDurableInvoiceRefund(
  db: DatabaseOrTransaction,
  provider: DurableRefundProvider,
  input: Scope & { operationId: string },
) {
  const { request } = await prepareInvoiceRefundRequest(db, input);
  return run(db, provider, { ...input, requestId: request.id });
}
export function resumeDurableInvoiceRefund(
  db: DatabaseOrTransaction,
  provider: DurableRefundProvider,
  input: Scope & { requestId: string },
) {
  return run(db, provider, input);
}
