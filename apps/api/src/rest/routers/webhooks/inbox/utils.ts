import type { Database } from "@midday/db/client";
import { createInbox } from "@midday/db/queries";
import { getInboxReceiptByReferenceId } from "@midday/db/queries/inbox-receipts";
import { triggerJob } from "@midday/job-client";
import { logger } from "@midday/logger";
import { createReceiptReferenceId } from "@midday/utils/receipt-path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ingestWebhookReceipts,
  type PreparedWebhookReceipt,
  prepareWebhookReceipts,
  type WebhookAttachment,
} from "../../../../services/inbox-webhook-ingestion";
import { enqueueInboxReceipt } from "../../../../services/inbox-webhook-queue";

export const POSTMARK_IP_RANGE = [
  "3.134.147.250",
  "50.31.156.6",
  "50.31.156.77",
  "18.217.206.57",
] as const;

export const ALLOWED_FORWARDING_EMAILS = [
  "forwarding-noreply@google.com",
] as const;
export const MIN_ATTACHMENT_SIZE_BYTES = 100000;

export function filterAttachments<T extends WebhookAttachment>(
  attachments: T[],
): T[] {
  return attachments.filter(
    (attachment) =>
      !(
        attachment.ContentLength < MIN_ATTACHMENT_SIZE_BYTES &&
        attachment.ContentType !== "application/pdf" &&
        attachment.ContentType !== "application/octet-stream"
      ),
  );
}

export async function receiveInboxAttachments(
  db: Database,
  supabase: SupabaseClient,
  input: Parameters<typeof prepareWebhookReceipts>[0],
) {
  const receipts = await prepareWebhookReceipts(input);
  // Both duplicate lookups and registration must observe committed primary
  // writes, including the first attempt whose HTTP response was lost.
  // biome-ignore lint/correctness/useHookAtTopLevel: Database primary selection is not a React hook.
  const primary = db.usePrimaryOnly();
  const storage = supabase.storage.from("vault");
  const findReceipt = (referenceId: string, expected: PreparedWebhookReceipt) =>
    getInboxReceiptByReferenceId(primary, {
      teamId: input.teamId,
      referenceId,
      expectedProof: { contentType: expected.contentType, meta: expected.meta },
    });
  const result = await ingestWebhookReceipts(receipts, {
    findReceipt,
    upload: async (receipt) => {
      const { data, error } = await storage.upload(
        receipt.filePath.join("/"),
        receipt.bytes,
        {
          contentType: receipt.contentType,
          upsert: false,
        },
      );
      return { path: data?.path, error };
    },
    download: async (path) => {
      const { data, error } = await storage.download(path);
      if (error || !data)
        throw new Error("Retained receipt bytes are unavailable");
      if (data.size > 50 * 1024 * 1024)
        throw new Error("Retained receipt is too large");
      return new Uint8Array(await data.arrayBuffer());
    },
    register: async (receipt) => {
      const {
        bytes: _bytes,
        contentSha256: _hash,
        attachmentIndex: _index,
        legacyReferenceId: _legacy,
        senderEmail,
        ...params
      } = receipt;
      await createInbox(primary, {
        ...params,
        senderEmail: senderEmail ?? undefined,
        status: "new",
      });
      const persisted = await findReceipt(receipt.referenceId, receipt);
      if (!persisted) throw new Error("Inbox registration was not retained");
      return persisted;
    },
    enqueue: enqueueInboxReceipt,
    failed: (attachmentIndex, code) =>
      logger.warn("Inbox attachment handoff failed", {
        teamId: input.teamId,
        attachmentIndex,
        code,
      }),
  });
  const activeAccepted = result.accepted - result.deleted;
  if (result.success && activeAccepted > 0) {
    const reference = await createReceiptReferenceId({
      teamId: input.teamId.toLowerCase(),
      platform: "postmark-notification",
      referenceId: input.messageId,
    });
    // Notification is not the durable ingestion receipt. Its failure cannot
    // undo the registered documents or demand another attachment upload.
    void triggerJob(
      "notification",
      {
        type: "inbox_new",
        teamId: input.teamId,
        totalCount: activeAccepted,
        inboxType: "email",
      },
      "notifications",
      { jobId: `inbox-email-${reference}` },
    ).catch(() => {
      logger.warn("Failed to enqueue inbound receipt notification", {
        teamId: input.teamId,
      });
    });
  }
  return result;
}
