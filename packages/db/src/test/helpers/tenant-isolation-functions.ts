import { sql } from "drizzle-orm";
import type { Database } from "../../client";
import { getTestDatabaseUrl } from "./test-database-config";

/**
 * Synthetic functions for the tracker query's shape on bare test Postgres.
 * These tests validate tenant CRUD/read fields, NOT production metric routines.
 * Existing functions are never replaced. Use only with getTestDatabase().
 */
export async function setupTenantIsolationQueryFunctions(
  db: Database,
): Promise<void> {
  getTestDatabaseUrl();
  await db.execute(sql`
    DO $fixture$
    BEGIN
      IF to_regprocedure('public.total_duration(public.tracker_projects)') IS NULL THEN
        EXECUTE 'CREATE FUNCTION public.total_duration(public.tracker_projects)
          RETURNS bigint LANGUAGE sql STABLE AS ''SELECT 0::bigint''';
      END IF;
      IF to_regprocedure('public.get_project_total_amount(public.tracker_projects)') IS NULL THEN
        EXECUTE 'CREATE FUNCTION public.get_project_total_amount(public.tracker_projects)
          RETURNS numeric LANGUAGE sql STABLE AS ''SELECT 0::numeric''';
      END IF;
      IF to_regprocedure('public.get_assigned_users_for_project(public.tracker_projects)') IS NULL THEN
        EXECUTE 'CREATE FUNCTION public.get_assigned_users_for_project(public.tracker_projects)
          RETURNS jsonb LANGUAGE sql STABLE AS ''SELECT ''''[]''''::jsonb''';
      END IF;
    END;
    $fixture$;
  `);
}
