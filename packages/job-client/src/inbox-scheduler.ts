import { getQueue } from "./queues";

/** Derive only our own scheduler identity, never a stored legacy cloud ID. */
export function inboxSyncSchedulerId(accountId: string): string {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      accountId,
    )
  )
    throw new Error("Invalid inbox account identity");
  return `scheduler:inbox-sync-${accountId.toLowerCase()}`;
}

export async function removeInboxSyncScheduler(
  accountId: string,
): Promise<boolean> {
  const schedulerId = inboxSyncSchedulerId(accountId);
  return getQueue("inbox-provider").removeJobScheduler(schedulerId);
}
