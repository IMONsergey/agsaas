import { enrichCustomer } from "@midday/customers";
import {
  claimCustomerEnrichment,
  completeCustomerEnrichment,
  failCustomerEnrichment,
  getCustomerForEnrichment,
  isCustomerEnrichmentCurrent,
} from "@midday/db/queries";
import type { Job } from "bullmq";
import type { EnrichCustomerPayload } from "../../schemas/customers";
import { executeCustomerEnrichment } from "../../utils/customer-enrichment-operation";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";

export class EnrichCustomerProcessor extends BaseProcessor<EnrichCustomerPayload> {
  async process(job: Job<EnrichCustomerPayload>) {
    const { customerId, teamId, operationId } = job.data;
    // A legacy job without an operation identity cannot establish a current intent.
    if (!operationId) return { customerId, status: "superseded" };
    const db = getDb();
    const lease = await claimCustomerEnrichment(db, {
      customerId,
      teamId,
      operationId,
    });
    if (!lease) return { customerId, status: "superseded" };
    if (!process.env.COMPANY_ENRICH_API_KEY?.trim()) {
      await failCustomerEnrichment(db, lease, "provider_not_configured");
      return { customerId, status: "failed" };
    }
    const customer = await getCustomerForEnrichment(db, { customerId, teamId });
    if (!customer) return { customerId, status: "not_found" };
    const result = await executeCustomerEnrichment({
      enrich: (signal) =>
        enrichCustomer(
          {
            companyName: customer.name,
            website: customer.website,
            email: customer.email,
          },
          { signal, timeoutMs: 30_000 },
        ),
      isCurrent: () => isCustomerEnrichmentCurrent(db, lease),
      complete: (result) =>
        completeCustomerEnrichment(db, lease, result.verified),
      fail: (code) => failCustomerEnrichment(db, lease, code),
    });
    this.logger.info("Customer enrichment operation finished", {
      operationId,
      status: result.status,
    });
    return { customerId, ...result };
  }
}
