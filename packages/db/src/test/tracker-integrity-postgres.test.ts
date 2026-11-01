import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../client";
import {
  bulkCreateTrackerEntries,
  getBillableHours,
  getCurrentTimer,
  startTimer,
  stopTimer,
  upsertTrackerEntries,
} from "../queries/tracker-entries";
import { trackerEntries, trackerProjects } from "../schema";
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
  "tracker price snapshots, calendar windows and timer concurrency (real PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
      await db
        .update(trackerProjects)
        .set({ billable: true, rate: 100, currency: "USD" })
        .where(eq(trackerProjects.id, fixture.own.projectId));
    });
    afterEach(async () => {
      if (fixture) await removeTenantIsolationFixture(db, fixture);
    });
    afterAll(closeDatabase);
    function entry(date: string, hours = 1) {
      return {
        teamId: fixture.own.teamId,
        projectId: fixture.own.projectId,
        assignedId: fixture.own.userId,
        dates: [date],
        start: `${date}T10:00:00.000Z`,
        stop: `${date}T${String(10 + hours).padStart(2, "0")}:00:00.000Z`,
        duration: hours * 3600,
      };
    }

    test("past time retains its price/currency after project changes and ordinary entry edits", async () => {
      const saved = await upsertTrackerEntries(db, entry("2060-11-01", 2));
      expect(saved[0]).toMatchObject({
        rate: 100,
        currency: "USD",
        billingSnapshotSource: "recorded",
      });
      await db
        .update(trackerProjects)
        .set({ rate: 150, currency: "EUR" })
        .where(eq(trackerProjects.id, fixture.own.projectId));
      const edited = await upsertTrackerEntries(db, {
        ...entry("2060-11-01", 2),
        id: saved[0]!.id,
        description: "Only a description edit",
      });
      expect(edited[0]).toMatchObject({ rate: 100, currency: "USD" });
      const fresh = await bulkCreateTrackerEntries(db, {
        teamId: fixture.own.teamId,
        entries: [entry("2060-11-02")],
      });
      expect(fresh[0]).toMatchObject({
        rate: 150,
        currency: "EUR",
        billingSnapshotSource: "recorded",
      });
      const totals = await getBillableHours(db, {
        teamId: fixture.own.teamId,
        date: "2060-11-15",
        view: "month",
        timezone: "UTC",
      });
      expect(totals.totalDuration).toBe(10800);
      expect(totals.earningsByCurrency).toEqual({ USD: 200, EUR: 150 });
    });

    test("work recorded while nonbillable does not become billable when project settings change", async () => {
      await db
        .update(trackerProjects)
        .set({ billable: false })
        .where(eq(trackerProjects.id, fixture.own.projectId));
      await upsertTrackerEntries(db, entry("2060-11-01"));
      await db
        .update(trackerProjects)
        .set({ billable: true, rate: 500 })
        .where(eq(trackerProjects.id, fixture.own.projectId));
      const totals = await getBillableHours(db, {
        teamId: fixture.own.teamId,
        date: "2060-11-15",
        view: "month",
      });
      expect(totals.totalDuration).toBe(3600);
      expect(totals.totalAmount).toBe(0);
    });

    test("month excludes buffered days and clips an entry that starts before the month", async () => {
      for (const [date, hours] of [
        ["2060-10-31", 1],
        ["2060-11-01", 2],
        ["2060-11-30", 3],
        ["2060-12-01", 4],
      ] as const)
        await upsertTrackerEntries(db, entry(date, hours));
      const period = {
        teamId: fixture.own.teamId,
        date: "2060-11-15",
        view: "month" as const,
        timezone: "UTC",
      };
      expect((await getBillableHours(db, period)).totalDuration).toBe(5 * 3600);
      await upsertTrackerEntries(db, {
        ...entry("2060-10-31"),
        start: "2060-10-31T23:00:00Z",
        stop: "2060-11-01T01:00:00Z",
        duration: 7200,
      });
      expect((await getBillableHours(db, period)).totalDuration).toBe(6 * 3600);
      expect(
        (
          await getBillableHours(db, {
            ...period,
            teamId: fixture.other.teamId,
          })
        ).totalDuration,
      ).toBe(0);
    });

    test("concurrent starts all succeed while one active row remains; stopping it leaves none", async () => {
      const params = {
        teamId: fixture.own.teamId,
        projectId: fixture.own.projectId,
        assignedId: fixture.own.userId,
      };
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => startTimer(db, params)),
      );
      expect(results.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(
        await db
          .select()
          .from(trackerEntries)
          .where(
            and(
              eq(trackerEntries.teamId, params.teamId),
              eq(trackerEntries.assignedId, params.assignedId),
              isNull(trackerEntries.stop),
            ),
          ),
      ).toHaveLength(1);
      const running = await getCurrentTimer(db, params);
      expect(running).toMatchObject({
        rate: 100,
        currency: "USD",
        billingSnapshotSource: "recorded",
      });
      await stopTimer(db, {
        ...params,
        stop: new Date(Date.now() + 120_000).toISOString(),
      });
      expect(await getCurrentTimer(db, params)).toBeNull();
      const rows = await db
        .select()
        .from(trackerEntries)
        .where(eq(trackerEntries.teamId, params.teamId));
      expect(rows.filter((row) => row.stop === null)).toHaveLength(0);
    });

    test("an invalid foreign project cannot stop the user's valid timer", async () => {
      const params = {
        teamId: fixture.own.teamId,
        projectId: fixture.own.projectId,
        assignedId: fixture.own.userId,
      };
      const timer = await startTimer(db, params);
      await expect(
        startTimer(db, { ...params, projectId: fixture.other.projectId }),
      ).rejects.toThrow();
      expect((await getCurrentTimer(db, params))?.id).toBe(timer.id);
      await startTimer(db, {
        teamId: fixture.other.teamId,
        projectId: fixture.other.projectId,
        assignedId: fixture.other.userId,
      });
      expect((await getCurrentTimer(db, params))?.id).toBe(timer.id);
    });
  },
);
