import { financialJobId, financialRequestHash } from "@midday/db/financial-job";
import type { FinancialJobDispatch } from "@midday/db/queries/financial-job-dispatches";
import {
  captureQueuedJobReservation,
  releaseQueuedJob,
  reserveQueuedJob,
} from "@midday/job-client/resource-admission";
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

export type FinancialDispatchAdmission = {
  reserve: typeof reserveQueuedJob;
  capture: typeof captureQueuedJobReservation;
  release: typeof releaseQueuedJob;
};
const financialAdmission: FinancialDispatchAdmission = {
  reserve: reserveQueuedJob,
  capture: captureQueuedJobReservation,
  release: releaseQueuedJob,
};

/** SQL owns retry identity. Retain the Redis receipt until SQL observes completion. */
export async function dispatchFinancialJob(
  row: FinancialJobDispatch,
  queue: FinancialDispatchQueue,
  admission: FinancialDispatchAdmission = financialAdmission,
) {
  if (
    !row.payload ||
    row.payload.teamId !== row.teamId ||
    financialRequestHash(row.payload) !== row.payloadHash
  )
    throw new Error("Invalid persisted financial job");
  const notBefore = row.payload.notBefore;
  const dueAt =
    notBefore === undefined ? undefined : Date.parse(String(notBefore));
  if (dueAt !== undefined && !Number.isFinite(dueAt))
    throw new Error("Invalid financial job schedule");
  const jobId = financialJobId(row.id);
  const reservation = await admission.capture(row.queueName, jobId, row.teamId);
  async function reserve() {
    const admittedId = await admission.reserve(
      row.queueName,
      row.payload,
      jobId,
      row.jobName,
    );
    if (admittedId !== jobId)
      throw new Error("Financial admission identity conflict");
  }
  const existing = await queue.getJob(jobId);
  if (existing) {
    if (
      existing.name !== row.jobName ||
      financialRequestHash(existing.data) !== row.payloadHash
    )
      throw new Error("Financial job receipt conflict");
    const state = await existing.getState();
    if (reservation && (state === "completed" || state === "failed"))
      await admission.release(
        row.queueName,
        jobId,
        row.teamId,
        reservation.generation,
      );
    if (state === "completed")
      return { status: "completed" as const, cleanup: () => existing.remove() };
    if (state === "failed") return { status: "failed" as const };
    // Adopt a retained pre-admission job without adding another queue entry.
    if (!reservation) await reserve();
    return { status: "accepted" as const };
  }
  // An ambiguous Queue.add failure retains this slot and stable SQL identity.
  // Only a confirmed terminal receipt can release its captured generation.
  await reserve();
  const created = await queue.add(row.jobName, row.payload, {
    jobId,
    ...(dueAt === undefined ? {} : { delay: Math.max(0, dueAt - Date.now()) }),
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: false,
    removeOnFail: false,
  });
  if (created.id !== jobId)
    throw new Error("Financial job was not acknowledged");
  return { status: "accepted" as const };
}
