import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { inbox } from "../schema";

/** Read the authoritative receipt including tombstones. Filtering deleted rows
 * would let an old webhook recreate an intentionally removed document. */
export async function getInboxReceiptByReferenceId(
  db: Database,
  params: { teamId: string; referenceId: string },
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
  return receipt;
}
