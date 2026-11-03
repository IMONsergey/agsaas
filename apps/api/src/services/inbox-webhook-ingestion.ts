import { createHash } from "node:crypto";
import type { InboxDeletedReceiptProof } from "@midday/db/queries/inbox-deletion-receipts";
import { createReceiptReferenceId } from "@midday/utils/receipt-path";
import { requireVaultPathForTeam } from "@midday/utils/storage-path";

const SOURCE_VERSION = "postmark-inbound-v1";
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 100;
const CONCURRENCY = 4;

export type WebhookAttachment = {
  Name: string;
  Content: string;
  ContentType: string;
  ContentLength: number;
  ContentID?: string;
};

export type InboxWebhookReceipt = {
  id: string;
  teamId: string | null;
  referenceId: string | null;
  filePath: string[] | null;
  fileName: string | null;
  contentType: string | null;
  size: number | null;
  status: string | null;
  senderEmail: string | null;
  meta: unknown;
  deletionProof?: InboxDeletedReceiptProof;
};

export type PreparedWebhookReceipt = {
  teamId: string;
  referenceId: string;
  legacyReferenceId: string;
  filePath: string[];
  fileName: string;
  displayName: string;
  contentType: string;
  size: number;
  senderEmail: string | null;
  bytes: Buffer;
  contentSha256: string;
  attachmentIndex: number;
  meta: {
    source: "postmark";
    sourceVersion: typeof SOURCE_VERSION;
    messageId: string;
    attachmentIndex: number;
    attachmentContentId: string;
    originalFileName: string;
    contentSha256: string;
  };
};

export type WebhookIngestionDependencies = {
  findReceipt(
    referenceId: string,
    expected: PreparedWebhookReceipt,
  ): Promise<InboxWebhookReceipt | undefined>;
  upload(
    receipt: PreparedWebhookReceipt,
  ): Promise<{ path?: string; error?: unknown }>;
  download(path: string): Promise<Uint8Array>;
  register(receipt: PreparedWebhookReceipt): Promise<InboxWebhookReceipt>;
  enqueue(
    receipt: InboxWebhookReceipt,
    stableReferenceId: string,
  ): Promise<"queued" | "completed">;
  failed?(attachmentIndex: number, code: string): void;
};

export class InvalidInboxWebhookAttachment extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInboxWebhookAttachment";
  }
}

class ReceiptConflict extends Error {
  constructor() {
    super("The retained receipt does not match this inbound attachment");
    this.name = "InboxWebhookReceiptConflict";
  }
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decode(attachment: WebhookAttachment) {
  if (
    !Number.isSafeInteger(attachment.ContentLength) ||
    attachment.ContentLength < 1 ||
    attachment.ContentLength > MAX_BYTES ||
    !attachment.Name ||
    attachment.Name.length > 1024 ||
    !attachment.ContentType ||
    attachment.ContentType.length > 127 ||
    (attachment.ContentID?.length ?? 0) > 1024 ||
    attachment.Content.length > Math.ceil(MAX_BYTES / 3) * 4 + 4096
  ) {
    throw new InvalidInboxWebhookAttachment(
      "Invalid attachment metadata or size",
    );
  }
  const base64 = attachment.Content.replace(/[\r\n\t ]/g, "");
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.byteLength !== attachment.ContentLength ||
    bytes.toString("base64") !== base64
  ) {
    throw new InvalidInboxWebhookAttachment(
      "Invalid attachment bytes or length",
    );
  }
  return bytes;
}

/** The source slot identifies a delivery; its bytes are a separate immutable
 * assertion. A changed payload must conflict instead of becoming a new receipt. */
export async function prepareWebhookReceipts(input: {
  teamId: string;
  messageId: string;
  attachments: readonly { attachment: WebhookAttachment; index: number }[];
  senderEmail: string | null;
  subject?: string;
}): Promise<PreparedWebhookReceipt[]> {
  const teamId = input.teamId.toLowerCase();
  requireVaultPathForTeam([teamId, "inbox", "uploads", "probe.bin"], teamId);
  if (
    !input.messageId.trim() ||
    input.messageId.length > 512 ||
    (input.subject?.length ?? 0) > 8192 ||
    (input.senderEmail?.length ?? 0) > 512 ||
    input.attachments.length > MAX_ATTACHMENTS
  ) {
    throw new InvalidInboxWebhookAttachment("Invalid inbound message identity");
  }
  const slots = new Set<number>();
  let total = 0;
  const result: PreparedWebhookReceipt[] = [];
  for (const { attachment, index } of input.attachments) {
    if (!Number.isSafeInteger(index) || index < 0 || slots.has(index)) {
      throw new InvalidInboxWebhookAttachment(
        "Invalid inbound attachment slot",
      );
    }
    slots.add(index);
    const bytes = decode(attachment);
    total += bytes.byteLength;
    if (total > MAX_BYTES) {
      throw new InvalidInboxWebhookAttachment(
        "Inbound attachments exceed 50 MiB",
      );
    }
    const referenceId = await createReceiptReferenceId({
      teamId,
      platform: "postmark",
      referenceId: JSON.stringify([SOURCE_VERSION, input.messageId, index]),
    });
    if (!referenceId) throw new Error("Missing inbound receipt identity");
    // The fixed suffix keeps the same object key even when a concurrent replay
    // changes its claimed MIME type. Original filename/MIME remain metadata.
    const filePath = [teamId, "inbox", "uploads", `${referenceId}.bin`];
    requireVaultPathForTeam(filePath, teamId);
    const contentSha256 = digest(bytes);
    result.push({
      teamId,
      referenceId,
      legacyReferenceId: `${input.messageId}_${attachment.Name}`,
      filePath,
      fileName: attachment.Name,
      displayName: input.subject || attachment.Name,
      contentType: attachment.ContentType,
      size: bytes.byteLength,
      senderEmail: input.senderEmail,
      bytes,
      contentSha256,
      attachmentIndex: index,
      meta: {
        source: "postmark",
        sourceVersion: SOURCE_VERSION,
        messageId: input.messageId,
        attachmentIndex: index,
        attachmentContentId: attachment.ContentID ?? "",
        originalFileName: attachment.Name,
        contentSha256,
      },
    });
  }
  return result;
}

function assertReceipt(
  receipt: InboxWebhookReceipt,
  expected: PreparedWebhookReceipt,
  legacy = false,
) {
  if (
    receipt.teamId?.toLowerCase() !== expected.teamId ||
    receipt.referenceId !==
      (legacy ? expected.legacyReferenceId : expected.referenceId) ||
    receipt.contentType !== expected.contentType ||
    receipt.size !== expected.size ||
    !receipt.status
  ) {
    throw new ReceiptConflict();
  }
  if (receipt.status === "deleted") {
    const proof = receipt.deletionProof;
    if (
      !proof ||
      proof.unavailable !== false ||
      proof.contentSha256 !== expected.contentSha256 ||
      proof.contentTypeMatches !== true ||
      typeof proof.metadataRetained !== "boolean" ||
      (!legacy && proof.metadataRetained !== true) ||
      (proof.metadataRetained && proof.metadataMatches !== true)
    ) {
      // Historical erasure without an original byte proof remains uncertain.
      // Neither absence nor a path match is evidence that changed bytes are safe.
      throw new ReceiptConflict();
    }
    return null;
  }
  const path = requireVaultPathForTeam(receipt.filePath ?? [], expected.teamId);
  if (legacy) {
    // Legacy lookups are scoped by both team and the exact old source key.
    // Arbitrary related documents are never adopted into a new delivery.
    if (path.pathArray.length !== 3 || path.pathArray[1] !== "inbox") {
      throw new ReceiptConflict();
    }
  } else {
    const meta = receipt.meta as Record<string, unknown> | null;
    if (
      path.normalizedPath !== expected.filePath.join("/") ||
      !meta ||
      !Object.entries(expected.meta).every(
        ([key, value]) => meta[key] === value,
      )
    ) {
      throw new ReceiptConflict();
    }
  }
  return path.normalizedPath;
}

async function assertStoredBytes(
  deps: WebhookIngestionDependencies,
  path: string,
  expected: PreparedWebhookReceipt,
) {
  const bytes = await deps.download(path);
  if (
    bytes.byteLength !== expected.size ||
    digest(bytes) !== expected.contentSha256
  ) {
    throw new ReceiptConflict();
  }
}

async function ensureImmutableUpload(
  deps: WebhookIngestionDependencies,
  expected: PreparedWebhookReceipt,
) {
  const path = expected.filePath.join("/");
  try {
    const result = await deps.upload(expected);
    if (!result.error && result.path === path) return;
  } catch {
    // The write may have committed before its response was lost. Verification
    // below also handles a concurrent upload's conflict without overwriting it.
  }
  await assertStoredBytes(deps, path, expected);
}

function needsProcessing(receipt: InboxWebhookReceipt) {
  return receipt.status === "new" || receipt.status === "processing";
}

async function ingestAttempt(
  deps: WebhookIngestionDependencies,
  expected: PreparedWebhookReceipt,
) {
  let receipt = await deps.findReceipt(expected.referenceId, expected);
  let legacy = false;
  let legacyPath: string | null = null;
  if (!receipt) {
    receipt = await deps.findReceipt(expected.legacyReferenceId, expected);
    legacy = !!receipt;
  }
  if (receipt) {
    const path = assertReceipt(receipt, expected, legacy);
    if (path === null) return "deleted" as const;
    if (legacy) {
      legacyPath = path;
      // Historical rows did not retain a content hash. A missing or different
      // object needs explicit reconciliation; never guess or create a duplicate.
      await assertStoredBytes(deps, path, expected);
    }
    if (!needsProcessing(receipt)) return;
  }
  if (!legacy) {
    await ensureImmutableUpload(deps, expected);
    if (!receipt) receipt = await deps.register(expected);
    if (assertReceipt(receipt, expected) === null) return "deleted" as const;
  }
  if (!receipt) throw new Error("Inbox receipt was not retained");
  // Registration is durable before the first queue write. Re-read primary
  // after external Storage work so a concurrent erasure is acknowledged from
  // its exact proof before any further handoff.
  const retained = await deps.findReceipt(receipt.referenceId!, expected);
  if (!retained) throw new Error("Inbox registration disappeared");
  const retainedPath = assertReceipt(retained, expected, legacy);
  if (retainedPath === null) return "deleted" as const;
  if (legacy && retainedPath !== legacyPath) throw new ReceiptConflict();
  receipt = retained;
  if (!needsProcessing(receipt)) return;
  const state = await deps.enqueue(receipt, expected.referenceId);
  if (state === "completed") {
    const current = await deps.findReceipt(receipt.referenceId!, expected);
    if (!current)
      throw new Error("Completed receipt lost its Inbox registration");
    if (assertReceipt(current, expected, legacy) === null)
      return "deleted" as const;
    if (needsProcessing(current)) {
      throw new Error("Completed receipt has no persisted processing outcome");
    }
  }
}

async function ingestOne(
  deps: WebhookIngestionDependencies,
  expected: PreparedWebhookReceipt,
) {
  try {
    return await ingestAttempt(deps, expected);
  } catch (error) {
    if (error instanceof ReceiptConflict) throw error;
    // Deletion may commit during an upload, registration, download fallback or
    // queue response. Re-read its durable proof; never infer success from error.
    let current = await deps.findReceipt(expected.referenceId, expected);
    let legacy = false;
    if (!current) {
      current = await deps.findReceipt(expected.legacyReferenceId, expected);
      legacy = !!current;
    }
    if (current?.status === "deleted") {
      assertReceipt(current, expected, legacy);
      return "deleted" as const;
    }
    throw error;
  }
}

/** Independent partial success is retained. Only complete durable handoff may
 * acknowledge the inbound delivery; replay fills its missing stages. */
export async function ingestWebhookReceipts(
  receipts: readonly PreparedWebhookReceipt[],
  deps: WebhookIngestionDependencies,
) {
  let accepted = 0;
  let failed = 0;
  let deleted = 0;
  for (let start = 0; start < receipts.length; start += CONCURRENCY) {
    const batch = receipts.slice(start, start + CONCURRENCY);
    const outcomes = await Promise.allSettled(
      batch.map((receipt) => ingestOne(deps, receipt)),
    );
    for (let index = 0; index < outcomes.length; index++) {
      const outcome = outcomes[index]!;
      if (outcome.status === "fulfilled") {
        accepted++;
        if (outcome.value === "deleted") deleted++;
      } else {
        failed++;
        const code =
          outcome.reason instanceof ReceiptConflict
            ? "identity_conflict"
            : "handoff_failed";
        deps.failed?.(batch[index]!.attachmentIndex, code);
      }
    }
  }
  return {
    success: failed === 0,
    attempted: receipts.length,
    accepted,
    failed,
    deleted,
  };
}
