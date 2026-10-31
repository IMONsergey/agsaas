import type { Job } from "bullmq";
import type { CancellationEmailsPayload } from "../../schemas/teams";
import { BaseProcessor } from "../base";

export class CancellationEmailFollowupProcessor extends BaseProcessor<CancellationEmailsPayload> {
  async process(job: Job<CancellationEmailsPayload>): Promise<void> {
    this.logger.info("Cancellation follow-up email skipped", {
      jobId: job.id,
      teamId: job.data.teamId,
    });
  }
}
