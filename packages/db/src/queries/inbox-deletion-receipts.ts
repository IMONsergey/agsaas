import { createHash } from "node:crypto";
import { requireVaultPathForTeam } from "@midday/utils/storage-path";
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import type { ResourceCleanup } from "./resource-cleanups";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const MAX_RECEIPT_BYTES = 50 * 1024 * 1024;

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Primary database selection is not a React hook.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}

export class InboxItemNotFoundError extends Error {
  constructor() {
    super("Inbox item not found");
    this.name = "InboxItemNotFoundError";
  }
}

export class InboxReceiptDeletedError extends Error {
  constructor() {
    super("The Inbox receipt was deleted");
    this.name = "InboxReceiptDeletedError";
  }
}

export function inboxDeletionIdentity(input: {
  teamId: string;
  referenceId?: string | null;
  filePath?: readonly string[] | null;
}) {
  const objectHash = input.filePath?.length
    ? hash(
        "vault:" +
          requireVaultPathForTeam(input.filePath, input.teamId).normalizedPath,
      )
    : null;
  return {
    referenceHash: input.referenceId == null ? null : hash(input.referenceId),
    objectHash,
  };
}

/** Acquire all source locks before object locks, in digest order, before row locks.
 * Multi-delete commands share this order even when two receipts use one object.
 * Row triggers use try-locks and reject any writer arriving in an inverted order. */
export async function lockInboxDeletionScopes(
  tx: DatabaseOrTransaction,
  teamId: string,
  inputs: readonly Omit<
    Parameters<typeof inboxDeletionIdentity>[0],
    "teamId"
  >[],
) {
  const identities = inputs.map((input) =>
    inboxDeletionIdentity({ ...input, teamId }),
  );
  await tx.execute(
    sql`SELECT private.lock_inbox_deletion_scope(${teamId}::uuid,NULL,NULL,false,false)`,
  );
  const references = [
    ...new Set(
      identities.flatMap((item) =>
        item.referenceHash ? [item.referenceHash] : [],
      ),
    ),
  ].sort();
  const objects = [
    ...new Set(
      identities.flatMap((item) => (item.objectHash ? [item.objectHash] : [])),
    ),
  ].sort();
  for (const reference of references) {
    await tx.execute(
      sql`SELECT private.lock_inbox_deletion_scope(${teamId}::uuid,${reference},NULL,false,false)`,
    );
  }
  for (const object of objects) {
    await tx.execute(
      sql`SELECT private.lock_inbox_deletion_scope(${teamId}::uuid,NULL,${object},false,false)`,
    );
  }
}

export async function lockInboxDeletionScope(
  tx: DatabaseOrTransaction,
  input: Parameters<typeof inboxDeletionIdentity>[0],
) {
  await lockInboxDeletionScopes(tx, input.teamId, [input]);
}

export async function isInboxReceiptDeleted(
  db: DatabaseOrTransaction,
  input: Parameters<typeof inboxDeletionIdentity>[0],
) {
  const identity = inboxDeletionIdentity(input);
  const result = await primary(db).execute<{ deleted: boolean }>(
    sql`SELECT (
      (${identity.referenceHash}::text IS NOT NULL AND EXISTS(
        SELECT 1 FROM private.inbox_deletion_receipts WHERE team_id=${input.teamId}::uuid AND reference_hash=${identity.referenceHash}))
      OR (${identity.objectHash}::text IS NOT NULL AND EXISTS(
        SELECT 1 FROM public.storage_deletion_tombstones WHERE team_id=${input.teamId}::uuid AND object_hash=${identity.objectHash}))
    ) AS deleted`,
  );
  return result.rows[0]?.deleted === true;
}

export type InboxDeletedReceiptProof = {
  contentSha256: string | null;
  contentTypeMatches: boolean | null;
  metadataMatches: boolean | null;
  metadataRetained: boolean;
  unavailable: boolean;
};

export type InboxDeletedReceipt = {
  id: string;
  teamId: string;
  referenceId: string;
  filePath: null;
  fileName: null;
  contentType: string | null;
  size: number | null;
  status: "deleted";
  senderEmail: null;
  meta: null;
  deletionProof: InboxDeletedReceiptProof;
};

export type InboxReceiptExpectedProof = {
  contentType: string;
  meta: Record<string, unknown>;
};

/** A virtual deleted receipt contains request-bound identity plus comparison
 * results. The private table never retains raw references, paths or metadata. */
export async function getInboxDeletedReceiptByReferenceId(
  db: DatabaseOrTransaction,
  input: {
    teamId: string;
    referenceId: string;
    expectedProof?: InboxReceiptExpectedProof;
  },
): Promise<InboxDeletedReceipt | undefined> {
  const expectedContentTypeHash = input.expectedProof
    ? hash(input.expectedProof.contentType)
    : null;
  const expectedMeta = input.expectedProof
    ? JSON.stringify(input.expectedProof.meta)
    : null;
  const result = await primary(db).execute<{
    id: string;
    size: number | null;
    contentSha256: string | null;
    contentTypeMatches: boolean | null;
    metadataMatches: boolean | null;
    metadataRetained: boolean;
    unavailable: boolean;
  }>(sql`SELECT inbox_id AS id, byte_size::double precision AS size,
    content_sha256 AS "contentSha256",
    content_type_hash = ${expectedContentTypeHash}::text AS "contentTypeMatches",
    metadata_sha256 = private.inbox_webhook_metadata_digest(${expectedMeta}::jsonb) AS "metadataMatches",
    metadata_sha256 IS NOT NULL AS "metadataRetained",
    digest_failure IS NOT NULL AS unavailable
    FROM private.inbox_deletion_receipts
    WHERE team_id=${input.teamId}::uuid AND reference_hash=${hash(input.referenceId)}
    LIMIT 1`);
  const found = result.rows[0];
  if (!found) return undefined;
  return {
    id: found.id,
    teamId: input.teamId,
    referenceId: input.referenceId,
    filePath: null,
    fileName: null,
    contentType: input.expectedProof?.contentType ?? null,
    size: found.size,
    status: "deleted",
    senderEmail: null,
    meta: null,
    deletionProof: {
      contentSha256: found.contentSha256,
      contentTypeMatches: found.contentTypeMatches,
      metadataMatches: found.metadataMatches,
      metadataRetained: found.metadataRetained,
      unavailable: found.unavailable,
    },
  };
}

/** Read only the current lease's pending digest bounds; no path or personal data. */
export async function getInboxDeletionDigestPlan(
  db: DatabaseOrTransaction,
  row: ResourceCleanup,
) {
  if (row.kind !== "storage-object" || !row.dispatchToken || !row.teamId)
    return { pending: 0, maximumBytes: 0 };
  const result = await primary(db).execute<{
    pending: number;
    maximumBytes: number;
  }>(sql`SELECT count(*)::int AS pending,
    COALESCE(max(CASE WHEN receipt.byte_size BETWEEN 1 AND ${MAX_RECEIPT_BYTES}
      THEN receipt.byte_size END),0)::int AS "maximumBytes"
    FROM private.inbox_deletion_receipts receipt
    JOIN public.resource_cleanups cleanup ON cleanup.team_id=receipt.team_id AND cleanup.target_id=receipt.object_hash
    WHERE cleanup.id=${row.id}::uuid AND cleanup.dispatch_token=${row.dispatchToken}::uuid
      AND cleanup.status='processing' AND cleanup.lease_expires_at>clock_timestamp()
      AND cleanup.kind='storage-object' AND receipt.content_sha256 IS NULL`);
  return result.rows[0] ?? { pending: 0, maximumBytes: 0 };
}

export async function retainInboxDeletionDigest(
  db: DatabaseOrTransaction,
  row: ResourceCleanup,
  evidence:
    | { sha256: string; size: number }
    | { failure: "download_unavailable" | "size_unverifiable" },
) {
  if (row.kind !== "storage-object" || !row.dispatchToken) return false;
  const digest = "sha256" in evidence ? evidence.sha256 : null;
  const size = "size" in evidence ? evidence.size : null;
  const failure = "failure" in evidence ? evidence.failure : null;
  const result = await primary(db).execute<{ retained: boolean }>(
    sql`SELECT private.retain_inbox_deletion_digest(
      ${row.id}::uuid,${row.dispatchToken}::uuid,${digest},${size}::bigint,${failure}
    ) AS retained`,
  );
  return result.rows[0]?.retained === true;
}
