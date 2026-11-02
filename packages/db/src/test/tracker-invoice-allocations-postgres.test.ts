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
import { InvoiceFinancialStateError } from "@midday/invoice/calculate";
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import {
  deleteInvoice,
  draftInvoice,
  getNextInvoiceNumber,
  updateInvoice,
} from "../queries/invoices";
import {
  deleteTrackerEntry,
  upsertTrackerEntries,
} from "../queries/tracker-entries";
import {
  allocateTrackerEntriesToInvoice,
  getUnbilledTrackerEntriesForInvoice,
} from "../queries/tracker-invoices";
import {
  invoices,
  trackerEntries,
  trackerInvoiceAllocations,
  trackerProjects,
} from "../schema";
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
  "tracker invoice allocation and concurrent billing (PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture;
    let entryIds: string[];
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
      await db
        .update(trackerProjects)
        .set({ billable: true, rate: 100, currency: "USD" })
        .where(eq(trackerProjects.id, fixture.own.projectId));
      entryIds = [];
      for (const date of ["2060-11-01", "2060-11-02"]) {
        const entries = await upsertTrackerEntries(db, {
          teamId: fixture.own.teamId,
          projectId: fixture.own.projectId,
          assignedId: fixture.own.userId,
          dates: [date],
          start: `${date}T10:00:00Z`,
          stop: `${date}T11:00:00Z`,
          duration: 3600,
        });
        entryIds.push(entries[0]!.id);
      }
    });
    afterEach(async () => {
      if (fixture) await removeTenantIsolationFixture(db, fixture);
    });
    afterAll(closeDatabase);
    function range() {
      return {
        teamId: fixture.own.teamId,
        projectId: fixture.own.projectId,
        from: "2060-11-01",
        to: "2060-11-30",
      };
    }
    async function createFromTrackedTime(failAfterAllocation = false) {
      return db.transaction(async (tx) => {
        const entries = await getUnbilledTrackerEntriesForInvoice(tx, range());
        if (!entries.length) return null;
        const invoiceId = randomUUID();
        await draftInvoice(tx, {
          id: invoiceId,
          teamId: fixture.own.teamId,
          userId: fixture.own.userId,
          customerId: fixture.own.customerId,
          token: "allocation-fixture-token",
          invoiceNumber: await getNextInvoiceNumber(tx, fixture.own.teamId),
          issueDate: "2060-11-30T00:00:00Z",
          dueDate: "2060-12-30T00:00:00Z",
          template: { currency: "USD" },
          lineItems: [
            {
              name: "Tracked work",
              quantity:
                entries.reduce((sum, entry) => sum + entry.duration!, 0) / 3600,
              price: 100,
            },
          ],
        });
        await allocateTrackerEntriesToInvoice(tx, {
          teamId: fixture.own.teamId,
          invoiceId,
          entryIds: entries.map((entry) => entry.id),
        });
        if (failAfterAllocation)
          throw new Error("fixture rollback after allocation");
        return invoiceId;
      });
    }

    test("concurrent requests reserve each entry for exactly one draft and a repeated period has no unbilled work", async () => {
      const results = await Promise.all([
        createFromTrackedTime(),
        createFromTrackedTime(),
      ]);
      const ids = results.filter((id) => id !== null);
      expect(ids).toHaveLength(1);
      const allocations = await db
        .select()
        .from(trackerInvoiceAllocations)
        .where(eq(trackerInvoiceAllocations.teamId, fixture.own.teamId));
      expect(allocations).toHaveLength(2);
      expect(
        allocations.every(
          (row) =>
            row.invoiceId === ids[0] &&
            row.duration === 3600 &&
            row.rate === 100 &&
            row.currency === "USD",
        ),
      ).toBe(true);
      expect(
        await getUnbilledTrackerEntriesForInvoice(db, range()),
      ).toHaveLength(0);
      expect(await createFromTrackedTime()).toBeNull();
    });

    test("deleting an unissued draft releases its reservation without deleting or repricing time", async () => {
      const invoiceId = (await createFromTrackedTime())!;
      await deleteInvoice(db, { id: invoiceId, teamId: fixture.own.teamId });
      const entries = await getUnbilledTrackerEntriesForInvoice(db, range());
      expect(entries).toHaveLength(2);
      expect(
        entries.every(
          (entry) =>
            entry.duration === 3600 &&
            entry.rate === 100 &&
            entry.billed === false,
        ),
      ).toBe(true);
      expect(
        await db
          .select()
          .from(trackerInvoiceAllocations)
          .where(eq(trackerInvoiceAllocations.teamId, fixture.own.teamId)),
      ).toHaveLength(0);
      expect(await createFromTrackedTime()).not.toBeNull();
    });

    test("allocated time cannot be edited/deleted, and canceling an issued invoice never releases it for rebilling", async () => {
      const invoiceId = (await createFromTrackedTime())!;
      await expect(
        upsertTrackerEntries(db, {
          id: entryIds[0],
          teamId: fixture.own.teamId,
          projectId: fixture.own.projectId,
          assignedId: fixture.own.userId,
          dates: ["2060-11-01"],
          start: "2060-11-01T10:00:00Z",
          stop: "2060-11-01T12:00:00Z",
          duration: 7200,
        }),
      ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
      await expect(
        deleteTrackerEntry(db, {
          id: entryIds[0]!,
          teamId: fixture.own.teamId,
        }),
      ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
      await updateInvoice(db, {
        id: invoiceId,
        teamId: fixture.own.teamId,
        status: "unpaid",
      });
      await updateInvoice(db, {
        id: invoiceId,
        teamId: fixture.own.teamId,
        status: "canceled",
      });
      await expect(
        deleteInvoice(db, { id: invoiceId, teamId: fixture.own.teamId }),
      ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
      expect(
        await getUnbilledTrackerEntriesForInvoice(db, range()),
      ).toHaveLength(0);
    });

    test("failed draft creation rolls back allocations and billed flags so work is available again", async () => {
      await expect(createFromTrackedTime(true)).rejects.toThrow(
        "rollback after allocation",
      );
      expect(
        await getUnbilledTrackerEntriesForInvoice(db, range()),
      ).toHaveLength(2);
      expect(
        await db
          .select()
          .from(trackerInvoiceAllocations)
          .where(eq(trackerInvoiceAllocations.teamId, fixture.own.teamId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(invoices)
          .where(eq(invoices.teamId, fixture.own.teamId)),
      ).toHaveLength(1);
    });

    test("a foreign entry cannot be allocated and running/legacy-billed records remain excluded", async () => {
      await expect(
        db.transaction((tx) =>
          allocateTrackerEntriesToInvoice(tx, {
            teamId: fixture.own.teamId,
            invoiceId: fixture.own.invoiceId,
            entryIds: [fixture.other.entryId],
          }),
        ),
      ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
      await db
        .update(trackerEntries)
        .set({ billed: true })
        .where(
          and(
            eq(trackerEntries.id, entryIds[0]!),
            eq(trackerEntries.teamId, fixture.own.teamId),
          ),
        );
      await db
        .update(trackerEntries)
        .set({ stop: null })
        .where(
          and(
            eq(trackerEntries.id, entryIds[1]!),
            eq(trackerEntries.teamId, fixture.own.teamId),
          ),
        );
      expect(
        await getUnbilledTrackerEntriesForInvoice(db, range()),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(trackerInvoiceAllocations)
          .where(eq(trackerInvoiceAllocations.teamId, fixture.own.teamId)),
      ).toHaveLength(0);
    });
  },
);
