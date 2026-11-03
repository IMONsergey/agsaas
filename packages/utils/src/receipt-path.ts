import { requireVaultPathForTeam } from "./storage-path";

/** Original filenames are display metadata; bytes are immutable object versions. */
export function createReceiptObjectPath(
  teamId: string,
  extension: string | null | undefined,
): string[] {
  const suffix =
    extension && /^\.[a-z0-9]{1,10}$/i.test(extension)
      ? extension.toLowerCase()
      : ".bin";
  const path = [teamId, "inbox", "uploads", `${crypto.randomUUID()}${suffix}`];
  requireVaultPathForTeam(path, teamId);
  return path;
}
/** Scope source idempotency keys; the DB reference index is global. */
export async function createReceiptReferenceId(params: {
  teamId: string;
  platform: string;
  userId?: string;
  referenceId?: string;
}): Promise<string | undefined> {
  if (!params.referenceId) return undefined;
  const content = JSON.stringify([
    params.teamId,
    params.platform,
    params.userId ?? "",
    params.referenceId,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return `receipt_${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
