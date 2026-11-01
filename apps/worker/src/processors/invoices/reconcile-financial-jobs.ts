import {
  claimFinancialJob,
  deferFinancialJob,
  listRecoverableFinancialJobs,
  recordFinancialJobState,
} from "@midday/db/queries/financial-job-dispatches";
import type { Job } from "bullmq";
import { getAllQueues } from "../../queues";
import { getDb } from "../../utils/db";
import { dispatchFinancialJob } from "../../utils/financial-job-dispatch";
import { BaseProcessor } from "../base";

/** Runs even when no recurring series is due. SQL intent is the recovery source. */
export class ReconcileFinancialJobsProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job<Record<string, never>>) {
    const db = getDb();
    const pending = await listRecoverableFinancialJobs(db);
    let accepted = 0;
    let completed = 0;
    let deferred = 0;
    for (const scope of pending) {
      const row = await claimFinancialJob(db, scope);
      if (!row) continue;
      try {
        const queue = getAllQueues().find(
          (candidate) => candidate.name === row.queueName,
        );
        if (!queue) throw new Error("Financial job queue is unavailable");
        const result = await dispatchFinancialJob(row, queue);
        await recordFinancialJobState(db, row, result.status);
        if (result.status === "completed") {
          completed++;
          // SQL is terminal before deleting a Redis receipt. Cleanup failure cannot replay work.
          try {
            await result.cleanup();
          } catch {
            /* Queue cleanup is best effort. */
          }
        } else if (result.status === "accepted") accepted++;
      } catch {
        await deferFinancialJob(db, row);
        deferred++;
        this.logger.warn("Financial job queue handoff deferred", {
          dispatchId: row.id,
        });
      }
    }
    return { scanned: pending.length, accepted, completed, deferred };
  }
}
