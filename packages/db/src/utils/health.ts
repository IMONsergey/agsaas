import { sql } from "drizzle-orm";

export async function checkHealth() {
  const { db } = await import("@midday/db/client");
  await db.executeOnReplica(sql`SELECT 1`);
}

/** Probe the same pool used by background jobs, not the API replica pool. */
export async function checkWorkerHealth() {
  const { getWorkerDb } = await import("@midday/db/worker-client");
  await getWorkerDb().execute(sql`SELECT 1`);
}
