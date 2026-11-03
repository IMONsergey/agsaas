import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  consumeRequestBudget,
  ResourceBudgetExceededError,
  reconcileStoppedWorkerAdmissions,
  withHeavyJobAdmission,
} from "../queries/resource-admission";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "resource admission (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);
    async function fixture(
      work: (
        teamId: string,
        userId: string,
        ownerRunId: string,
      ) => Promise<void>,
    ) {
      const teamId = randomUUID(),
        userId = randomUUID(),
        run = randomUUID();
      try {
        await work(teamId, userId, run);
      } finally {
        await db.execute(
          sql`DELETE FROM public.request_resource_budgets WHERE bucket IN (${`user:${userId}`}, ${`team:${teamId}`})`,
        );
        await db.execute(
          sql`DELETE FROM public.heavy_job_admissions WHERE owner_run_id = ${run}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM public.resource_admission_reconciliations WHERE owner_run_id = ${run}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM public.security_audit_events WHERE team_id = ${teamId}::uuid`,
        );
      }
    }
    test("concurrent requests cannot exceed a user budget and a denial rolls back the team debit", async () =>
      fixture(async (teamId, userId) => {
        // Freeze this test's window across a wall-clock minute boundary.
        await db.execute(
          sql`INSERT INTO public.request_resource_budgets(bucket,window_start,used) VALUES (${`user:${userId}`},now()+interval '1 minute',0),(${`team:${teamId}`},now()+interval '1 minute',0)`,
        );
        const results = await Promise.allSettled(
          Array.from({ length: 20 }, () =>
            consumeRequestBudget(db, { teamId, userId, cost: 100 }),
          ),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(6);
        expect(
          results.filter(
            (r) =>
              r.status === "rejected" &&
              r.reason instanceof ResourceBudgetExceededError,
          ),
        ).toHaveLength(14);
        const rows = await db.execute<{ used: number }>(
          sql`SELECT used FROM public.request_resource_budgets WHERE bucket IN (${`user:${userId}`}, ${`team:${teamId}`}) ORDER BY bucket`,
        );
        expect(rows.rows.map((row) => row.used)).toEqual([600, 600]);
      }));
    test("the next window restores capacity without changing another tenant's budget", async () =>
      fixture(async (teamId, userId) => {
        await consumeRequestBudget(db, { userId, teamId, cost: 100 });
        await db.execute(
          sql`UPDATE public.request_resource_budgets SET window_start = now() - interval '2 minutes', used = 600 WHERE bucket = ${`user:${userId}`}`,
        );
        await consumeRequestBudget(db, { userId, teamId, cost: 1 });
        const rows = await db.execute<{ bucket: string; used: number }>(
          sql`SELECT bucket, used FROM public.request_resource_budgets WHERE bucket IN (${`user:${userId}`}, ${`team:${teamId}`}) ORDER BY bucket`,
        );
        expect(rows.rows.map((row) => row.used)).toEqual([101, 1]);
      }));
    test("active ticket remains until work settles; duplicate or concurrent actor work cannot overlap", async () =>
      fixture(async (teamId, userId, ownerRunId) => {
        let started!: () => void, finish!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        const held = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const first = withHeavyJobAdmission(
          db,
          { teamId, userId, ownerRunId, jobKey: "test:job1" },
          async () => {
            started();
            await held;
            return 1;
          },
        );
        try {
          await entered;
          let ran = false;
          await expect(
            withHeavyJobAdmission(
              db,
              { teamId, userId, ownerRunId, jobKey: "test:job2" },
              async () => {
                ran = true;
              },
            ),
          ).rejects.toBeInstanceOf(ResourceBudgetExceededError);
          expect(ran).toBe(false);
          const ticket = await db.execute(
            sql`SELECT id FROM public.heavy_job_admissions WHERE owner_run_id = ${ownerRunId}::uuid`,
          );
          expect(ticket.rows).toHaveLength(1);
        } finally {
          finish();
          await first;
        }
        expect(
          await withHeavyJobAdmission(
            db,
            { teamId, userId, ownerRunId, jobKey: "test:job2" },
            async () => 2,
          ),
        ).toBe(2);
      }));
    test("a crash ticket has no TTL and requires recorded stopped-process evidence", async () =>
      fixture(async (teamId, userId, ownerRunId) => {
        await db.execute(
          sql`INSERT INTO public.heavy_job_admissions(id,team_id,user_id,owner_run_id,job_hash,started_at) VALUES (${randomUUID()}::uuid,${teamId}::uuid,${userId}::uuid,${ownerRunId}::uuid,${randomUUID()},now()-interval '2 days')`,
        );
        await expect(
          withHeavyJobAdmission(
            db,
            { teamId, userId, ownerRunId, jobKey: "test:after-crash" },
            async () => 1,
          ),
        ).rejects.toBeInstanceOf(ResourceBudgetExceededError);
        await expect(
          reconcileStoppedWorkerAdmissions(db, {
            ownerRunId,
            evidenceReference: "",
          }),
        ).rejects.toThrow();
        expect(
          await reconcileStoppedWorkerAdmissions(db, {
            ownerRunId,
            evidenceReference: "TEST-WORKER-STOPPED-001",
          }),
        ).toBe(1);
        expect(
          await withHeavyJobAdmission(
            db,
            { teamId, userId, ownerRunId, jobKey: "test:after-crash" },
            async () => 1,
          ),
        ).toBe(1);
        const audit = await db.execute(
          sql`SELECT id FROM public.resource_admission_reconciliations WHERE owner_run_id = ${ownerRunId}::uuid`,
        );
        expect(audit.rows).toHaveLength(1);
      }));
  },
);
