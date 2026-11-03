import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import type { StoredExportArchiveReceipt } from "../export-archive-receipt";

export type ExportFileAccessReceipt = StoredExportArchiveReceipt & {
  transaction_assets_safe: boolean;
};

const OPERATION = /^[a-f0-9]{64}$/;

/** Read only bounded receipt metadata from the primary authority. */
export async function getExportFileAccessReceipts(
  db: DatabaseOrTransaction,
  input: { teamId: string; operationIds: readonly string[] },
): Promise<ExportFileAccessReceipt[]> {
  if (
    input.operationIds.length > 100 ||
    input.operationIds.some((id) => !OPERATION.test(id))
  )
    throw new Error("Invalid export access lookup");
  const ids = [...new Set(input.operationIds)];
  if (ids.length === 0) return [];
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  const primary = "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
  const result = await primary.execute<ExportFileAccessReceipt>(sql`
    select id, team_id, operation_key, snapshot_hash,
      snapshot->>'kind' as snapshot_kind,
      snapshot->>'version' as snapshot_version,
      snapshot->>'asOf' as snapshot_at,
      -- Old transaction receipts must not launder a reserved export via an
      -- attachment. Compute one boolean; no business rows leave PostgreSQL.
      case when snapshot->>'kind'='transactions'
        and jsonb_typeof(snapshot->'transactionRows')='array'
      then not exists (
        select 1 from jsonb_array_elements(snapshot->'transactionRows') as transaction_row(value)
        where jsonb_typeof(transaction_row.value) is distinct from 'object'
          or case when jsonb_typeof(transaction_row.value->'attachments')='array'
            then exists (
              select 1 from jsonb_array_elements(transaction_row.value->'attachments') as attachment(value)
              where jsonb_typeof(attachment.value) is distinct from 'object'
                or case
                  when attachment.value->'path'='null'::jsonb then false
                  when jsonb_typeof(attachment.value->'path')='array' then
                    jsonb_array_length(attachment.value->'path')>0 and (
                      jsonb_array_length(attachment.value->'path')<2
                      or lower(attachment.value->'path'->>0) is distinct from team_id::text
                      or attachment.value->'path'->>1='exports'
                      or exists (
                        select 1 from jsonb_array_elements(attachment.value->'path') as segment(value)
                        where jsonb_typeof(segment.value) is distinct from 'string'
                          or segment.value #>> '{}' in ('','.','..')
                          or segment.value #>> '{}' ~ '[/%?#[:cntrl:]]'
                          or strpos(segment.value #>> '{}',chr(92))>0
                      )
                    )
                  else true
                end
            )
            else true
          end
      ) else false end as transaction_assets_safe,
      case when result is null then null else jsonb_build_object(
        'status', result->'status',
        'operationId', result->'operationId',
        'snapshotId', result->'snapshotId',
        'snapshotHash', result->'snapshotHash',
        'archiveHash', result->'archiveHash',
        'fullPath', result->'fullPath',
        'totalItems', result->'totalItems',
        'missingFiles', result->'missingFiles'
      ) end as result
    from public.export_snapshots
    where team_id=${input.teamId}::uuid
      and operation_key=any(ARRAY[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[])
    limit 100
  `);
  return result.rows;
}
