import type { Job } from "bullmq";
import type { DeleteTeamPayload } from "../../schemas/teams";
import { NonRetryableError } from "../../utils/error-classification";
import { BaseProcessor } from "../base";

/** Legacy Redis jobs are not proof of a committed local deletion. New requests
 * use the SQL cleanup ledger and the reconcile-bank-connections scheduler. */
export class DeleteTeamProcessor extends BaseProcessor<DeleteTeamPayload> {
  protected getDiagnosticPayload(job: Job<DeleteTeamPayload>) {
    return {
      legacyBankCleanup: true,
      connectionCount: Array.isArray(job.data?.connections)
        ? job.data.connections.length
        : null,
    };
  }

  async process(job: Job<DeleteTeamPayload>) {
    if (
      !Array.isArray(job.data?.connections) ||
      job.data.connections.length > 0
    ) {
      // Do not copy legacy credentials into new jobs, logs or automatic sends.
      throw new NonRetryableError(
        "Legacy bank cleanup requires operator reconciliation",
        undefined,
        "validation",
      );
    }
    return { teamId: job.data.teamId, connectionsDeleted: 0 };
  }
}
