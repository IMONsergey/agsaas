import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { financialJobOperationKey } from "../financial-job";
import {
  claimFinancialJob,
  ensureFinancialJobDispatch,
  listRecoverableFinancialJobs,
  recordFinancialJobState,
} from "../queries/financial-job-dispatches";
import {
  checkInvoiceExists,
  lockDueInvoiceRecurring,
  markInvoiceGenerated,
} from "../queries/invoice-recurring";
import { financialJobDispatches, invoiceRecurring, invoices } from "../schema";
import {
  createTenantIsolationFixture,
  removeTenantIsolationFixture,
  type TenantIsolationFixture,
} from "./helpers/tenant-isolation-fixture";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "recurring SQL handoff and queue recovery (PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
    });
    afterEach(async () => {
      if (fixture) await removeTenantIsolationFixture(db, fixture);
    });
    afterAll(closeDatabase);
    async function recurring() {
      const [row] = await db
        .insert(invoiceRecurring)
        .values({
          teamId: fixture.own.teamId,
          userId: fixture.own.userId,
          customerId: fixture.own.customerId,
          frequency: "monthly_date",
          frequencyDay: 1,
          endType: "after_count",
          endCount: 1,
          timezone: "UTC",
          nextScheduledAt: new Date(Date.now() - 3600000).toISOString(),
        })
        .returning();
      return row!;
    }
    function intent(invoiceId: string, source: string) {
      return {
        teamId: fixture.own.teamId,
        jobName: "generate-invoice" as const,
        source,
        payload: {
          teamId: fixture.own.teamId,
          invoiceId,
          deliveryType: "create_and_send",
          deliveryKey: financialJobOperationKey("generate-invoice", source),
        },
      };
    }

    test("two schedulers cannot advance the same sequence twice; completed series retains a recoverable handoff", async () => {
      const series = await recurring();
      const invoiceId = randomUUID();
      const run = () =>
        db.transaction(async (tx) => {
          const locked = await lockDueInvoiceRecurring(tx, {
            id: series.id,
            teamId: series.teamId,
            nextSequence: 1,
            nextScheduledAt: series.nextScheduledAt,
          });
          if (!locked) return false;
          await tx.insert(invoices).values({
            id: invoiceId,
            teamId: series.teamId,
            invoiceNumber: "RECURRING-100",
            invoiceRecurringId: series.id,
            recurringSequence: 1,
          });
          await ensureFinancialJobDispatch(
            tx,
            intent(invoiceId, `${series.id}/1`),
          );
          await markInvoiceGenerated(tx, {
            id: series.id,
            teamId: series.teamId,
          });
          return true;
        });
      expect((await Promise.all([run(), run()])).sort()).toEqual([false, true]);
      expect(
        (
          await db
            .select()
            .from(invoiceRecurring)
            .where(eq(invoiceRecurring.id, series.id))
        )[0],
      ).toMatchObject({
        status: "completed",
        invoicesGenerated: 1,
        nextScheduledAt: null,
      });
      expect(
        await checkInvoiceExists(db, {
          teamId: fixture.other.teamId,
          invoiceRecurringId: series.id,
          recurringSequence: 1,
        }),
      ).toBeNull();
      const pending = (await listRecoverableFinancialJobs(db, 100)).filter(
        (row) => row.teamId === series.teamId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.payload?.invoiceId).toBe(invoiceId);
    });

    test("a failure before commit rolls back invoice, intent and series advancement together", async () => {
      const series = await recurring();
      const invoiceId = randomUUID();
      await expect(
        db.transaction(async (tx) => {
          await lockDueInvoiceRecurring(tx, {
            id: series.id,
            teamId: series.teamId,
            nextSequence: 1,
            nextScheduledAt: series.nextScheduledAt,
          });
          await tx.insert(invoices).values({
            id: invoiceId,
            teamId: series.teamId,
            invoiceNumber: "ROLLBACK-100",
            invoiceRecurringId: series.id,
            recurringSequence: 1,
          });
          await ensureFinancialJobDispatch(
            tx,
            intent(invoiceId, `${series.id}/1`),
          );
          await markInvoiceGenerated(tx, {
            id: series.id,
            teamId: series.teamId,
          });
          throw new Error("fixture failure before commit");
        }),
      ).rejects.toThrow("before commit");
      expect(
        await db.select().from(invoices).where(eq(invoices.id, invoiceId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(financialJobDispatches)
          .where(eq(financialJobDispatches.teamId, series.teamId)),
      ).toHaveLength(0);
      expect(
        (
          await db
            .select()
            .from(invoiceRecurring)
            .where(eq(invoiceRecurring.id, series.id))
        )[0]?.invoicesGenerated,
      ).toBe(0);
    });

    test("same immutable operation replays once, rejects changed bytes and keeps queue acceptance distinct from completion", async () => {
      const request = intent(fixture.own.invoiceId, "fixture-operation");
      const row = await ensureFinancialJobDispatch(db, request);
      expect((await ensureFinancialJobDispatch(db, request)).id).toBe(row.id);
      await expect(
        ensureFinancialJobDispatch(db, {
          ...request,
          payload: { ...request.payload, invoiceId: randomUUID() },
        }),
      ).rejects.toThrow("conflict");
      const claims = await Promise.all([
        claimFinancialJob(db, row),
        claimFinancialJob(db, row),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(
        await claimFinancialJob(db, { ...row, teamId: fixture.other.teamId }),
      ).toBeNull();
      await recordFinancialJobState(db, row, "accepted");
      await db
        .update(financialJobDispatches)
        .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(financialJobDispatches.id, row.id));
      expect(
        (await listRecoverableFinancialJobs(db, 100)).some(
          (item) => item.id === row.id,
        ),
      ).toBe(true);
      await recordFinancialJobState(db, row, "completed");
      expect(
        (await listRecoverableFinancialJobs(db, 100)).some(
          (item) => item.id === row.id,
        ),
      ).toBe(false);
      expect(
        (
          await db
            .select()
            .from(financialJobDispatches)
            .where(
              and(
                eq(financialJobDispatches.id, row.id),
                eq(financialJobDispatches.teamId, row.teamId),
              ),
            )
        )[0],
      ).toMatchObject({ status: "completed", payload: null });
    });
  },
);
