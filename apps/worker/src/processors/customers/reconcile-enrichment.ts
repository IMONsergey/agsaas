import { listPendingCustomerEnrichments } from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import type { Job } from "bullmq";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";
export class ReconcileCustomerEnrichmentProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job<Record<string, never>>) {
    const pending = await listPendingCustomerEnrichments(getDb(), 50);
    let queued = 0;
    for (const operation of pending) {
      await triggerJob(
        "enrich-customer",
        {
          customerId: operation.customerId,
          teamId: operation.teamId,
          operationId: operation.operationId,
        },
        "customers",
        {
          jobId: `enrich-${operation.operationId}-${operation.attemptCount}`,
          attempts: 1,
        },
      );
      queued++;
    }
    return { queued };
  }
}
