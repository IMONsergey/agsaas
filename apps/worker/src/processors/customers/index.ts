import { EnrichCustomerProcessor } from "./enrich-customer";
import { ReconcileCustomerEnrichmentProcessor } from "./reconcile-enrichment";

/**
 * Export all customer processors (for type imports)
 */
export { EnrichCustomerProcessor } from "./enrich-customer";

/**
 * Customer processor registry
 * Maps job names to processor instances
 */
export const customerProcessors = {
  "reconcile-customer-enrichment": new ReconcileCustomerEnrichmentProcessor(),
  "enrich-customer": new EnrichCustomerProcessor(),
};
