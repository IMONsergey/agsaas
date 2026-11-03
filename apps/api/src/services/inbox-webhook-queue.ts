import { getQueue, triggerJob } from "@midday/job-client";
import { captureQueuedJobReservation } from "@midday/job-client/resource-admission";
import {
  inboxRetrySnapshot,
  retryInboxJobWithAdmission,
} from "@midday/job-client/retry-inbox-job";
import { requireVaultPathForTeam } from "@midday/utils/storage-path";
import type { Job } from "bullmq";
import type { InboxWebhookReceipt } from "./inbox-webhook-ingestion";

export type InboxReceiptPayload = {
  teamId: string;
  filePath: string[];
  mimetype: string;
  size: number;
  referenceId: string;
  senderEmail?: string;
};

export type RetainedInboxJob = Pick<
  Job,
  | "name"
  | "data"
  | "getState"
  | "finishedOn"
  | "attemptsMade"
  | "attemptsStarted"
  | "opts"
>;

export type InboxReceiptQueueDependencies = {
  find(id: string): Promise<RetainedInboxJob | undefined>;
  enqueue(id: string, payload: InboxReceiptPayload): Promise<unknown>;
  retry(
    id: string,
    payload: InboxReceiptPayload,
    job: RetainedInboxJob,
  ): Promise<unknown>;
  confirmAdmission(id: string, payload: InboxReceiptPayload): Promise<void>;
};

function assertJob(job: RetainedInboxJob, payload: InboxReceiptPayload) {
  const data = job.data as Record<string, unknown> | null;
  if (
    job.name !== "process-attachment" ||
    !data ||
    Object.keys(data).length !== Object.keys(payload).length ||
    !Object.entries(payload).every(([key, value]) =>
      Array.isArray(value)
        ? Array.isArray(data[key]) &&
          JSON.stringify(data[key]) === JSON.stringify(value)
        : data[key] === value,
    )
  ) {
    throw new Error("Retained Inbox job identity conflict");
  }
}

/** Retry preserves the owned job ID and atomically admits a captured failed
 * attempt. A terminal job is never deleted to make a retry appear successful. */
export function createInboxReceiptQueue(deps: InboxReceiptQueueDependencies) {
  return async (
    receipt: InboxWebhookReceipt,
    stableReferenceId: string,
  ): Promise<"queued" | "completed"> => {
    if (
      !/^receipt_[a-f0-9]{64}$/.test(stableReferenceId) ||
      !receipt.teamId ||
      !receipt.contentType ||
      !receipt.referenceId ||
      !receipt.size ||
      !Number.isSafeInteger(receipt.size) ||
      receipt.size < 1
    ) {
      throw new Error("Invalid registered Inbox receipt");
    }
    const path = requireVaultPathForTeam(
      receipt.filePath ?? [],
      receipt.teamId,
    );
    const payload: InboxReceiptPayload = {
      teamId: receipt.teamId,
      filePath: path.pathArray,
      mimetype: receipt.contentType,
      size: receipt.size,
      referenceId: receipt.referenceId,
      ...(receipt.senderEmail ? { senderEmail: receipt.senderEmail } : {}),
    };
    const id = `postmark-${stableReferenceId}`;
    let job = await deps.find(id);
    if (!job) {
      try {
        await deps.enqueue(id, payload);
      } catch {
        // Enqueue may have committed despite a lost response. Only an exact
        // retained job below can turn that ambiguous response into acceptance.
      }
      job = await deps.find(id);
      if (!job) throw new Error("Inbox processing was not queued");
    }
    assertJob(job, payload);
    let state = await job.getState();
    if (state === "failed") {
      try {
        await deps.retry(id, payload, job);
      } catch {
        // Another replay may already have retried the same job. Re-read its
        // identity and state; an unrelated or still failed job is not success.
      }
      job = await deps.find(id);
      if (!job) throw new Error("Retried Inbox job disappeared");
      assertJob(job, payload);
      state = await job.getState();
    }
    if (state === "completed") return "completed";
    if (
      [
        "waiting",
        "active",
        "delayed",
        "prioritized",
        "paused",
        "waiting-children",
      ].includes(state)
    ) {
      // A native Lua error can leave a queued job with a pending reservation.
      // Such a job is deliberately blocked at worker capture and is not an ACK.
      await deps.confirmAdmission(id, payload);
      return "queued";
    }
    throw new Error("Inbox processing has no active queue handoff");
  };
}

export const enqueueInboxReceipt = createInboxReceiptQueue({
  find: (id) => getQueue("inbox").getJob(id),
  enqueue: (id, payload) =>
    triggerJob("process-attachment", payload, "inbox", { jobId: id }),
  retry: (id, _payload, job) =>
    retryInboxJobWithAdmission(id, job.data, inboxRetrySnapshot(job)),
  confirmAdmission: async (id, payload) => {
    if (!(await captureQueuedJobReservation("inbox", id, payload.teamId))) {
      throw new Error("Inbox processing has no retained admission");
    }
  },
});
