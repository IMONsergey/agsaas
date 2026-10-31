import type { Job } from "bullmq";
import type { CancellationEmailsPayload } from "../../schemas/teams";
import { BaseProcessor } from "../base";

export class CancellationEmailsProcessor extends BaseProcessor<CancellationEmailsPayload> {
  async process(job: Job<CancellationEmailsPayload>): Promise<void> {
    this.logger.info("Cancellation email skipped", {
      jobId: job.id,
      teamId: job.data.teamId,
    });
  }
}
