import type { BankSyncScope } from "@midday/db/queries/bank-sync";
import type { Job } from "bullmq";
import { z } from "zod";
import { getDb } from "../../utils/db";
import { runNativeBankSync } from "../../utils/native-bank-sync";
import { BaseProcessor } from "../base";

export class SyncBankConnectionProcessor extends BaseProcessor<BankSyncScope> {
  protected getPayloadSchema() {
    return z
      .object({ connectionId: z.string().uuid(), teamId: z.string().uuid() })
      .strict();
  }
  async process(job: Job<BankSyncScope>) {
    try {
      return await runNativeBankSync(getDb(), job.data);
    } catch {
      throw new Error("Bank synchronization awaits durable recovery");
    }
  }
}
