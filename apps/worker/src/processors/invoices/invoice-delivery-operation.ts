import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { NonRetryableError } from "../../utils/error-classification";

/** Same queued operation keeps its identity across retries and PDF handoffs. */
export function invoiceDeliveryOperationKey(params: {
  teamId: string;
  invoiceId: string;
  kind: "invoice" | "reminder";
  job: Pick<Job, "id" | "name" | "timestamp">;
  expectedScheduledJobId?: string;
  deliveryKey?: string;
}): string {
  if (params.deliveryKey !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(params.deliveryKey))
      throw new NonRetryableError("Invalid invoice delivery operation key");
    return params.deliveryKey;
  }
  const source =
    params.expectedScheduledJobId !== undefined
      ? ["scheduled", params.expectedScheduledJobId]
      : ["job", params.job.name, params.job.id, params.job.timestamp];
  if (
    params.expectedScheduledJobId === undefined &&
    (!params.job.id ||
      !Number.isFinite(params.job.timestamp) ||
      params.job.timestamp <= 0)
  ) {
    throw new NonRetryableError(
      "Invoice delivery requires a durable job identity",
    );
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        "invoice-email-v1",
        params.teamId,
        params.invoiceId,
        params.kind,
        ...source,
      ]),
    )
    .digest("hex");
}
