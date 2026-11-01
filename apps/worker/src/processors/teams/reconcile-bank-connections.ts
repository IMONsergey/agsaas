import { listRecoverableBankConnectionCleanups } from "@midday/db/queries/bank-connection-cleanups";
import type { Job } from "bullmq";
import { cleanupBankConnection } from "../../utils/bank-connection-cleanup";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";

/** The cron payload is empty; provider credentials stay exclusively in SQL. */
export class ReconcileBankConnectionsProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job<Record<string, never>>) {
    const db = getDb();
    const due = await listRecoverableBankConnectionCleanups(db, 10);
    let completed = 0,
      pending = 0,
      reconciliation = 0;
    // Bound the batch to fit the queue's lock and provider timeouts. Each row
    // has its own durable SQL fence across concurrent workers/restarts.
    await Promise.all(
      due.map(async ({ id }) => {
        try {
          const result = await cleanupBankConnection(db, id);
          if (result.status === "completed") completed++;
          else if (result.status === "reconciliation") reconciliation++;
          else pending++;
        } catch {
          reconciliation++;
          this.logger.warn("Bank cleanup reconciliation required", {
            cleanupId: id,
          });
        }
      }),
    );
    return { scanned: due.length, completed, pending, reconciliation };
  }
}
