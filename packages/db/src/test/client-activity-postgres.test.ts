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
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { getMostActiveClient } from "../queries/invoices";
import {
  customers,
  invoices,
  trackerEntries,
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
  "independent client activity aggregates (PostgreSQL)",
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
    test("three invoices do not multiply one hour of tracker time and change the winner", async () => {
      const teamId = fixture.own.teamId;
      const today = new Date().toISOString().slice(0, 10);
      await db
        .update(trackerEntries)
        .set({ date: today, duration: 3600 })
        .where(eq(trackerEntries.id, fixture.own.entryId));
      await db.insert(invoices).values(
        [1, 2].map((n) => ({
          teamId,
          customerId: fixture.own.customerId,
          invoiceNumber: `ACTIVITY-A-${n}`,
        })),
      );
      const customerId = randomUUID();
      const projectId = randomUUID();
      await db
        .insert(customers)
        .values({
          id: customerId,
          teamId,
          name: "One invoice and four hours",
          email: "activity-fixture@example.test",
        });
      await db
        .insert(invoices)
        .values({ teamId, customerId, invoiceNumber: "ACTIVITY-B" });
      await db
        .insert(trackerProjects)
        .values({ id: projectId, teamId, customerId, name: "Four hours" });
      await db
        .insert(trackerEntries)
        .values({ teamId, projectId, date: today, duration: 14400 });
      const result = await getMostActiveClient(db, { teamId });
      expect(result).toMatchObject({
        customerId,
        invoiceCount: 1,
        totalTrackerTime: 14400,
      });
      expect(result?.customerId).not.toBe(fixture.own.customerId);
      expect(result?.customerId).not.toBe(fixture.other.customerId);
    });
    test("old tracker entries and another tenant cannot make a client active", async () => {
      await db.delete(invoices).where(eq(invoices.id, fixture.own.invoiceId));
      expect(
        await getMostActiveClient(db, { teamId: fixture.own.teamId }),
      ).toBeNull();
    });
  },
);
