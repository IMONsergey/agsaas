import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { inbox } from "../schema";
import {
  getInboxDeletedReceiptByReferenceId,
  type InboxReceiptExpectedProof,
} from "./inbox-deletion-receipts";

/** Read active first, then erasure evidence on primary. Deletion commits the
 * evidence and physical removal atomically: reading in the reverse order could
 * miss both rows when deletion commits between the two commands. */
export async function getInboxReceiptByReferenceId(
  db: Database,
  params: {
    teamId: string;
    referenceId: string;
    expectedProof?: InboxReceiptExpectedProof;
  },
) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database primary selection is not a React hook.
  const [receipt] = await db
    .usePrimaryOnly()
    .select({
      id: inbox.id,
      teamId: inbox.teamId,
      referenceId: inbox.referenceId,
      filePath: inbox.filePath,
      fileName: inbox.fileName,
      contentType: inbox.contentType,
      size: inbox.size,
      status: inbox.status,
      senderEmail: inbox.senderEmail,
      meta: inbox.meta,
    })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        eq(inbox.referenceId, params.referenceId),
      ),
    )
    .limit(1);
  return receipt ?? getInboxDeletedReceiptByReferenceId(db, params);
}
