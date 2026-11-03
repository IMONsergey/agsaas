import { sql } from "drizzle-orm";
import type { Database, DatabaseOrTransaction } from "../client";
import { financialRequestHash } from "../financial-job";
import { getTransactionsByIds } from "./transactions";

export type ExportKind = "transactions" | "team";
export type ExportDataSnapshot = {
  version: 1;
  teamId: string;
  kind: ExportKind;
  asOf: string;
  consistency: "repeatable-read";
  tables: Record<string, Record<string, unknown>[]>;
  transactionRows: Awaited<ReturnType<typeof getTransactionsByIds>>;
  requestedTransactionIds: string[];
  omissions: string[];
};
export type ExportSnapshotRecord = {
  id: string;
  team_id: string;
  operation_key: string;
  request_hash: string;
  snapshot: ExportDataSnapshot;
  snapshot_hash: string;
  result: Record<string, unknown> | null;
};

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}

const TEAM_TABLES: Record<string, string[]> = {
  transactions: ["fts_vector"],
  transaction_attachments: [],
  transaction_tags: [],
  transaction_categories: [],
  tags: [],
  bank_accounts: [],
  bank_connections: [
    "access_token",
    "enrollment_id",
    "reference_id",
    "error_details",
  ],
  customers: ["token", "fts"],
  customer_tags: [],
  invoices: ["token", "fts"],
  invoice_templates: [],
  invoice_products: ["fts"],
  invoice_recurring: [],
  invoice_payment_reservations: [],
  invoice_settlement_entries: [],
  invoice_settlement_state: [],
  invoice_email_deliveries: ["envelope", "lease_token"],
  tracker_projects: [],
  tracker_entries: [],
  tracker_invoice_allocations: [],
  documents: ["fts", "fts_simple", "fts_english", "fts_language"],
  document_tags: [],
  document_tag_assignments: [],
  inbox: ["fts"],
  accounting_sync_records: ["error_message"],
  team_quota_usage: [],
  team_connector_reservations: [],
};

async function capture(
  db: DatabaseOrTransaction,
  teamId: string,
  kind: ExportKind,
  ids: string[],
) {
  const time = await db.execute<{ at: string }>(
    sql`select transaction_timestamp()::text as at`,
  );
  const asOf = new Date(time.rows[0]!.at).toISOString();
  const tables: ExportDataSnapshot["tables"] = {};
  if (kind === "team") {
    for (const [table, removed] of Object.entries(TEAM_TABLES)) {
      // Identifiers come only from the literal export contract above, never from a request.
      const result = await db.execute<{ row: Record<string, unknown> }>(sql`
        select to_jsonb(t) - ARRAY[${sql.join(
          removed.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[] as row
        from ${sql.identifier(table)} t where t.team_id = ${teamId}::uuid
        order by to_jsonb(t)::text
      `);
      tables[table] = result.rows.map((item) => item.row);
    }
    tables.documents = tables.documents!.filter((row) => {
      const path = row.path_tokens;
      return !(Array.isArray(path) && path[1] === "exports");
    });
    const documentIds = new Set(tables.documents!.map((row) => row.id));
    tables.document_tag_assignments = tables.document_tag_assignments!.filter(
      (row) => documentIds.has(row.document_id),
    );
    const team = await db.execute<{ row: Record<string, unknown> }>(sql`
      select to_jsonb(t) - 'inbox_id' as row from teams t where id = ${teamId}::uuid
    `);
    tables.teams = team.rows.map((item) => item.row);
    const members = await db.execute<{ row: Record<string, unknown> }>(sql`
      select jsonb_build_object('id',u.id,'full_name',u.full_name,'email',u.email,'role',m.role) as row
      from users u join users_on_team m on m.user_id=u.id where m.team_id=${teamId}::uuid order by u.id
    `);
    tables.members = members.rows.map((item) => item.row);
    const activity = await db.execute<{ row: Record<string, unknown> }>(sql`
      select to_jsonb(a) as row from activities a where a.team_id=${teamId}::uuid
      and a.type::text like 'invoice_%' order by a.id
    `);
    tables.invoice_activities = activity.rows.map((item) => item.row);
  } else {
    const rows = await db.execute<{ row: Record<string, unknown> }>(sql`
      select to_jsonb(t) - 'fts_vector' as row from transactions t
      where t.team_id=${teamId}::uuid and t.id = any(ARRAY[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]) order by t.id
    `);
    tables.transactions = rows.rows.map((item) => item.row);
  }
  const requestedTransactionIds =
    kind === "team"
      ? tables.transactions!.map((row) => String(row.id)).sort()
      : [...new Set(ids)].sort();
  // This query only uses select(); a transaction intentionally shares its read snapshot.
  const transactionRows = await getTransactionsByIds(db as Database, {
    teamId,
    ids: requestedTransactionIds,
  });
  transactionRows.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1 as const,
    teamId,
    kind,
    asOf,
    consistency: "repeatable-read" as const,
    tables,
    transactionRows,
    requestedTransactionIds,
    omissions: [
      "Authentication, OAuth/provider credentials, API keys, link bearer tokens, delivery envelopes and leases are excluded.",
      "Generated export archives and their document tag assignments are excluded to prevent recursive archives.",
      "Search indexes are derived data and are excluded. Bank account encrypted fields remain encrypted as stored.",
      "This portable business export is not a disaster recovery backup or a provider transaction history API dump.",
      "SQL values share one repeatable-read boundary. File bytes are fetched afterwards and individually hashed; historical object versions are not asserted.",
    ],
  } satisfies ExportDataSnapshot;
}

/** Persist the exact selection/data before file IO. A retry never rereads changing UI list queries. */
export async function getOrCreateExportSnapshot(
  db: DatabaseOrTransaction,
  input: {
    teamId: string;
    operationKey: string;
    kind: ExportKind;
    request: Record<string, unknown>;
    transactionIds?: string[];
  },
) {
  if (!/^[a-f0-9]{64}$/.test(input.operationKey))
    throw new Error("Invalid export operation identity");
  const requestHash = financialRequestHash({
    kind: input.kind,
    request: input.request,
    transactionIds:
      input.kind === "transactions"
        ? [...new Set(input.transactionIds ?? [])].sort()
        : [],
  });
  const lookup = async () => {
    const result = await primary(db).execute<ExportSnapshotRecord>(sql`
      select * from export_snapshots where team_id=${input.teamId}::uuid and operation_key=${input.operationKey}
    `);
    const row = result.rows[0];
    if (
      row &&
      (row.request_hash !== requestHash ||
        financialRequestHash(row.snapshot) !== row.snapshot_hash)
    )
      throw new Error(
        "Export operation identity or snapshot integrity conflict",
      );
    return row;
  };
  const existing = await lookup();
  if (existing) return existing;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await primary(db).transaction(
        async (tx) => {
          const snapshot = await capture(
            tx,
            input.teamId,
            input.kind,
            input.transactionIds ?? [],
          );
          await tx.execute(sql`
      insert into export_snapshots(team_id,operation_key,request_hash,snapshot,snapshot_hash)
      values(${input.teamId}::uuid,${input.operationKey},${requestHash},${JSON.stringify(snapshot)}::jsonb,${financialRequestHash(snapshot)})
      on conflict(team_id,operation_key) do nothing
    `);
        },
        { isolationLevel: "repeatable read" },
      );
      break;
    } catch (error) {
      const failure = error as { code?: string; cause?: { code?: string } };
      if ((failure.cause?.code ?? failure.code) !== "40001" || attempt === 2)
        throw error;
      // A concurrent creator may have committed the same operation while this
      // repeatable-read transaction held an older view. Retry the SQL boundary.
    }
  }
  const saved = await lookup();
  if (!saved) throw new Error("Export snapshot was not persisted");
  return saved;
}

export async function recordExportResult(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    teamId: string;
    result: Record<string, unknown>;
  },
) {
  await primary(db).execute(sql`
    update export_snapshots set result=${JSON.stringify(input.result)}::jsonb, updated_at=clock_timestamp()
    where id=${input.id}::uuid and team_id=${input.teamId}::uuid
      and (result is null or result->>'status' <> 'complete')
  `);
}

/** Never mark newer financial data exported merely because an earlier snapshot finished. */
export async function markSnapshotTransactionsExported(
  db: DatabaseOrTransaction,
  input: {
    teamId: string;
    rows: Record<string, unknown>[];
    completeIds: string[];
  },
) {
  const complete = new Set(input.completeIds);
  let marked = 0;
  for (const row of input.rows) {
    if (!complete.has(String(row.id))) continue;
    const result = await primary(db).execute(sql`
      update transactions t set status='exported'
      where t.team_id=${input.teamId}::uuid and t.id=${String(row.id)}::uuid
      and ((to_jsonb(t) - 'fts_vector') = ${JSON.stringify(row)}::jsonb
        or (t.status='exported' and (to_jsonb(t) - 'fts_vector' - 'status') = (${JSON.stringify(row)}::jsonb - 'status')))
      returning id
    `);
    marked += result.rowCount ?? 0;
  }
  return marked;
}
