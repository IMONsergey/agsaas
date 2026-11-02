import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { transactionTags } from "../schema";
import { assertTeamOwnership } from "../utils/tenant-ownership";

type CreateTransactionTagParams = {
  teamId: string;
  transactionId: string;
  tagId: string;
};

export async function createTransactionTag(
  db: Database,
  params: CreateTransactionTagParams,
) {
  return db.transaction(async (tx) => {
    await assertTeamOwnership(tx, params.teamId, "transactions", [
      params.transactionId,
    ]);
    await assertTeamOwnership(tx, params.teamId, "tags", [params.tagId]);

    return tx
      .insert(transactionTags)
      .values({
        teamId: params.teamId,
        transactionId: params.transactionId,
        tagId: params.tagId,
      })
      .returning();
  });
}

type DeleteTransactionTagParams = {
  transactionId: string;
  tagId: string;
  teamId: string;
};

export async function deleteTransactionTag(
  db: Database,
  params: DeleteTransactionTagParams,
) {
  const { transactionId, tagId, teamId } = params;

  return db
    .delete(transactionTags)
    .where(
      and(
        eq(transactionTags.transactionId, transactionId),
        eq(transactionTags.tagId, tagId),
        eq(transactionTags.teamId, teamId),
      ),
    );
}
