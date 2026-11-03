import { listDueOnboarding } from "@midday/db/queries/onboarding-deliveries";
import { wakeNativeJob } from "@midday/job-client/native-wakeup";
import type { Job } from "bullmq";
import { z } from "zod";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";
export class ReconcileOnboardingProcessor extends BaseProcessor<
  Record<string, never>
> {
  protected getPayloadSchema() {
    return z.object({}).strict();
  }
  async process(_job: Job<Record<string, never>>) {
    const due = await listDueOnboarding(getDb(), 10);
    const results = await Promise.allSettled(
      due.map((scope) =>
        wakeNativeJob({ name: "deliver-onboarding", payload: scope }),
      ),
    );
    return {
      scanned: due.length,
      queued: results.filter((item) => item.status === "fulfilled").length,
    };
  }
}
