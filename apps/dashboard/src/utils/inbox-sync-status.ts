/** Own queue states only. A lost/expired job must not leave the spinner running. */
export function inboxSyncPhase(
  jobId: string | undefined,
  state: string | undefined,
  hasError = false,
): "SYNCING" | "COMPLETED" | "FAILED" | null {
  if (!jobId) return null;
  if (hasError || state === "failed" || state === "unknown") return "FAILED";
  if (state === "completed") return "COMPLETED";
  return "SYNCING";
}

/** This count means attachments queued for processing, not finished OCR. */
export function inboxQueuedAttachmentCount(
  result: unknown,
): number | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return undefined;
  const count = (result as { attachmentsProcessed?: unknown })
    .attachmentsProcessed;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : undefined;
}
