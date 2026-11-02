import { financialJobId, financialRequestHash } from "@midday/db/financial-job";
import type { FinancialJobDispatch } from "@midday/db/queries/financial-job-dispatches";
import type { JobsOptions } from "bullmq";

type QueuedJob = {
  name: string;
  data: unknown;
  getState(): Promise<string>;
  remove(): Promise<unknown>;
};

export type FinancialDispatchQueue = {
  getJob(id: string): Promise<QueuedJob | undefined | null>;
  add(
    name: string,
    payload: Record<string, unknown>,
    options: JobsOptions,
  ): Promise<{ id?: string }>;
};

/** SQL owns retry identity. Retain the Redis receipt until SQL observes completion. */
export async function dispatchFinancialJob(
  row: FinancialJobDispatch,
  queue: FinancialDispatchQueue,
) {
  if (
    !row.payload ||
    row.payload.teamId !== row.teamId ||
    financialRequestHash(row.payload) !== row.payloadHash
  )
    throw new Error("Invalid persisted financial job");
  const jobId = financialJobId(row.id);
  const existing = await queue.getJob(jobId);
  if (existing) {
    if (
      existing.name !== row.jobName ||
      financialRequestHash(existing.data) !== row.payloadHash
    )
      throw new Error("Financial job receipt conflict");
    const state = await existing.getState();
    if (state === "completed")
      return { status: "completed" as const, cleanup: () => existing.remove() };
    if (state === "failed") return { status: "failed" as const };
    return { status: "accepted" as const };
  }
  const created = await queue.add(row.jobName, row.payload, {
    jobId,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: false,
    removeOnFail: false,
  });
  if (created.id !== jobId)
    throw new Error("Financial job was not acknowledged");
  return { status: "accepted" as const };
}
