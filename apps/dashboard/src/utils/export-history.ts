import type { RouterOutputs } from "@api/trpc/routers/_app";

export type TeamExportHistoryEntry =
  RouterOutputs["team"]["exportHistory"]["items"][number];
export type TeamExportHistoryReceipt =
  RouterOutputs["team"]["exportHistoryEntry"];

// This function reads an existing receipt only. It never starts or retries work.
// A current-scope callback is checked after the await, so a completed old-team
// request cannot enable a download after navigation or sign-out.
export async function confirmExportHistoryDownload(input: {
  entry: TeamExportHistoryEntry;
  teamId: string;
  scope: string;
  currentScope: () => string | null;
  read: (id: string) => Promise<TeamExportHistoryReceipt>;
}) {
  const expected = input.entry;
  if (!expected.archive || input.currentScope() !== input.scope) return null;
  const response = await input.read(expected.id);
  if (input.currentScope() !== input.scope) return null;
  const current = response.item;
  if (
    response.teamId !== input.teamId ||
    !current?.archive ||
    current.id !== expected.id ||
    current.operationId !== expected.operationId ||
    current.snapshotHash !== expected.snapshotHash ||
    current.outcome !== expected.outcome ||
    current.totalItems !== expected.totalItems ||
    current.missingFiles !== expected.missingFiles ||
    current.archive.path !== expected.archive.path ||
    current.archive.fileName !== expected.archive.fileName ||
    current.archive.sha256 !== expected.archive.sha256
  )
    throw new Error("The export receipt could not be confirmed");
  return current.archive;
}

export const exportHistoryOutcomeLabel = {
  unknown: "Outcome not yet confirmed",
  unverified: "Result could not be verified",
  complete: "Complete archive",
  partial: "Incomplete archive",
  failed: "Failed export",
} as const;
