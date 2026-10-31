import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  accountingSyncRecords,
  inbox,
  transactionAttachments,
  transactionMatchSuggestions,
  transactions,
} from "../schema";
import {
  assertTeamOwnership,
  TenantResourceNotFoundError,
} from "../utils/tenant-ownership";
import { createActivity } from "./activities";

export type Attachment = {
  type: string;
  name: string;
  size: number;
  path: string[];
  transactionId?: string;
};

type CreateAttachmentsParams = {
  attachments: Attachment[];
  teamId: string;
  userId?: string;
};

export async function createAttachments(
  db: Database,
  params: CreateAttachmentsParams,
) {
  const { attachments, teamId, userId } = params;

  return db.transaction(async (tx) => {
    await assertTeamOwnership(
      tx,
      teamId,
      "transactions",
      attachments.map((attachment) => attachment.transactionId),
    );

    const result = await tx
      .insert(transactionAttachments)
      .values(
        attachments.map((attachment) => ({
          ...attachment,
          teamId,
        })),
      )
      .returning();

    // Reset export status for affected transactions so they reappear in review
    const transactionIds = [
      ...new Set(
        result
          .map((a) => a.transactionId)
          .filter((id): id is string => id !== null),
      ),
    ];

    if (transactionIds.length > 0) {
      await tx
        .delete(accountingSyncRecords)
        .where(
          and(
            inArray(accountingSyncRecords.transactionId, transactionIds),
            eq(accountingSyncRecords.teamId, teamId),
          ),
        );
    }

    // Create activity for each attachment created
    for (const attachment of result) {
      await createActivity(tx, {
        teamId,
        userId,
        type: "transaction_attachment_created",
        source: "user",
        priority: 7,
        metadata: {
          attachmentId: attachment.id,
          transactionId: attachment.transactionId,
          fileName: attachment.name,
          fileSize: attachment.size,
          fileType: attachment.type,
        },
      });
    }

    return result;
  });
}

type DeleteAttachmentParams = {
  id: string;
  teamId: string;
};

type GetTransactionAttachmentParams = {
  transactionId: string;
  attachmentId: string;
  teamId: string;
};

export async function getTransactionAttachment(
  db: Database,
  params: GetTransactionAttachmentParams,
) {
  const { transactionId, attachmentId, teamId } = params;

  const [result] = await db
    .select({
      id: transactionAttachments.id,
      name: transactionAttachments.name,
      path: transactionAttachments.path,
      type: transactionAttachments.type,
      size: transactionAttachments.size,
      transactionId: transactionAttachments.transactionId,
      teamId: transactionAttachments.teamId,
    })
    .from(transactionAttachments)
    .innerJoin(
      transactions,
      eq(transactionAttachments.transactionId, transactions.id),
    )
    .where(
      and(
        eq(transactionAttachments.id, attachmentId),
        eq(transactionAttachments.transactionId, transactionId),
        eq(transactionAttachments.teamId, teamId),
        eq(transactions.teamId, teamId),
      ),
    );

  return result;
}

export async function deleteAttachment(
  db: Database,
  params: DeleteAttachmentParams,
) {
  return db.transaction(async (tx) => {
    // First get the attachment to delete
    const [result] = await tx
      .select({
        id: transactionAttachments.id,
        transactionId: transactionAttachments.transactionId,
        name: transactionAttachments.name,
        teamId: transactionAttachments.teamId,
      })
      .from(transactionAttachments)
      .where(
        and(
          eq(transactionAttachments.id, params.id),
          eq(transactionAttachments.teamId, params.teamId),
        ),
      )
      .for("update");

    if (!result) {
      throw new TenantResourceNotFoundError();
    }

    // Collect affected inbox IDs BEFORE clearing their foreign keys, so we can
    // update the corresponding match suggestions afterwards.
    const affectedInboxIds: string[] = [];
    if (result.transactionId) {
      const rows = await tx
        .select({ id: inbox.id })
        .from(inbox)
        .where(
          and(
            eq(inbox.teamId, params.teamId),
            sql`(${inbox.attachmentId} = ${result.id} OR ${inbox.transactionId} = ${result.transactionId})`,
          ),
        );
      for (const r of rows) affectedInboxIds.push(r.id);
    }

    // Update inbox items connected to this attachment
    await tx
      .update(inbox)
      .set({
        attachmentId: null,
        transactionId: null,
        status: "pending",
      })
      .where(
        and(eq(inbox.attachmentId, result.id), eq(inbox.teamId, params.teamId)),
      );

    if (result.transactionId) {
      await tx
        .update(inbox)
        .set({
          transactionId: null,
          status: "pending",
        })
        .where(
          and(
            eq(inbox.transactionId, result.transactionId),
            eq(inbox.teamId, params.teamId),
            sql`(${inbox.attachmentId} IS NULL OR ${inbox.attachmentId} != ${result.id})`,
          ),
        );
    }

    // Mark match suggestions as "unmatched" so retry matching can create fresh ones.
    // Without this, createMatchSuggestion's onConflictDoUpdate silently skips rows
    // with status "confirmed", leaving the inbox stuck in "suggested_match" with no
    // pending suggestion the user can act on.
    if (result.transactionId && affectedInboxIds.length > 0) {
      for (const inboxId of affectedInboxIds) {
        const [originalSuggestion] = await tx
          .select({ id: transactionMatchSuggestions.id })
          .from(transactionMatchSuggestions)
          .where(
            and(
              eq(transactionMatchSuggestions.inboxId, inboxId),
              eq(
                transactionMatchSuggestions.transactionId,
                result.transactionId!,
              ),
              eq(transactionMatchSuggestions.teamId, params.teamId),
            ),
          )
          .orderBy(desc(transactionMatchSuggestions.createdAt))
          .limit(1);

        if (originalSuggestion) {
          await tx
            .update(transactionMatchSuggestions)
            .set({
              status: "unmatched",
              userActionAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(transactionMatchSuggestions.id, originalSuggestion.id),
                eq(transactionMatchSuggestions.teamId, params.teamId),
              ),
            );
        }
      }
    }

    // Delete tax_rate and tax_type from the transaction
    if (result.transactionId) {
      await tx
        .update(transactions)
        .set({ taxRate: null, taxType: null })
        .where(
          and(
            eq(transactions.id, result.transactionId),
            eq(transactions.teamId, params.teamId),
          ),
        );

      // Reset export status so transaction reappears in review
      await tx
        .delete(accountingSyncRecords)
        .where(
          and(
            eq(accountingSyncRecords.transactionId, result.transactionId),
            eq(accountingSyncRecords.teamId, params.teamId),
          ),
        );
    }

    // Delete the attachment
    return tx
      .delete(transactionAttachments)
      .where(
        and(
          eq(transactionAttachments.id, params.id),
          eq(transactionAttachments.teamId, params.teamId),
        ),
      );
  });
}
