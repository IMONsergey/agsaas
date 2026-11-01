import { createHash } from "node:crypto";
import { validateStorageKey } from "@midday/supabase/storage-path";
import { ensureFileExtension } from "@midday/utils";

/** Provider filenames are untrusted labels. Each attachment gets a stable,
 * account-scoped object identity so equal names cannot overwrite each other. */
export function inboxAttachmentStorageKey(input: {
  teamId: string;
  accountId: string;
  referenceId: string;
  filename: string;
  mimeType: string;
}): string {
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    !uuid.test(input.teamId) ||
    !uuid.test(input.accountId) ||
    !input.referenceId ||
    input.referenceId.length > 4096
  )
    throw new Error("Invalid inbox attachment identity");
  const filename =
    input.filename
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._ -]/gu, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 180) || "attachment";
  const digest = createHash("sha256").update(input.referenceId).digest("hex");
  return validateStorageKey(
    `${input.teamId}/inbox/${input.accountId}/${digest}/${ensureFileExtension(filename, input.mimeType)}`,
  );
}
