import { sql } from "drizzle-orm";
import type { Database } from "../client";

/** Uses the primary DB and a server-only bounded SQL function. No caller
 * supplied object paths, no service-role Storage downloads, no event replay. */
export async function reconcileStorageDocuments(db: Database, batchSize = 50) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error("Document reconciliation batch must be between 1 and 200");
  }
  // biome-ignore lint/correctness/useHookAtTopLevel: database primary selection is not a React hook
  const result = await db.usePrimaryOnly().execute(sql`
    SELECT private.reconcile_storage_documents(${batchSize}::integer) AS result
  `);
  const value = result.rows[0]?.result as
    | { created: number; updated: number; missing: number }
    | undefined;
  if (!value) throw new Error("Document reconciliation returned no result");
  return value;
}
