import { pruneRequestBudgets } from "@midday/db/queries/resource-admission";
import { claimResourceCleanups } from "@midday/db/queries/resource-cleanups";
import { reconcileQueuedJobs } from "@midday/job-client/resource-admission";
import type { Job } from "bullmq";
import { getDb } from "../../utils/db";
import { runResourceCleanup } from "../../utils/resource-cleanup";
import { BaseProcessor } from "../base";

export class ReconcileResourceCleanupsProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job<Record<string, never>>) {
    const db = getDb();
    await pruneRequestBudgets(db);
    await reconcileQueuedJobs();
    const due = await claimResourceCleanups(db, 5);
    const outcomes = await Promise.all(
      due.map((row) => runResourceCleanup(db, row)),
    );
    return {
      scanned: due.length,
      completed: outcomes.filter((status) => status === "completed").length,
    };
  }
}
