import { listDueBankSync } from "@midday/db/queries/bank-sync";
import { wakeNativeJob } from "@midday/job-client/native-wakeup";
import type { Job } from "bullmq";
import { z } from "zod";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";

export class ReconcileBankSyncProcessor extends BaseProcessor<
  Record<string, never>
> {
  protected getPayloadSchema() {
    return z.object({}).strict();
  }
  async process(_job: Job<Record<string, never>>) {
    const due = await listDueBankSync(getDb(), 20);
    const results = await Promise.allSettled(
      due.map((scope) =>
        wakeNativeJob({ name: "sync-bank-connection", payload: scope }),
      ),
    );
    return {
      scanned: due.length,
      queued: results.filter((item) => item.status === "fulfilled").length,
    };
  }
}
