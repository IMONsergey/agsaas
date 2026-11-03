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
import {
  createReport,
  getChartDataByLinkId,
  getReportByLinkId,
  getReports,
  listSharedReports,
  revokeSharedReport,
} from "../queries/reports";
import { reports, transactions, transactionCategories } from "../schema";
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
  "public immutable report snapshots (isolated PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
      await db
        .insert(transactionCategories)
        .values({
          teamId: fixture.own.teamId,
          slug: "revenue",
          name: "Revenue",
          system: true,
        });
      await db
        .update(transactions)
        .set({
          categorySlug: "revenue",
          amount: 120,
          taxRate: 20,
          internal: false,
          status: "posted",
        })
        .where(eq(transactions.id, fixture.own.transactionId));
    });
    afterEach(async () => {
      if (fixture) await removeTenantIsolationFixture(db, fixture);
    });
    afterAll(closeDatabase);
    const params = () => ({
      teamId: fixture.own.teamId,
      createdBy: fixture.own.userId,
      type: "revenue" as const,
      from: "2026-01-01",
      to: "2026-01-31",
      currency: "USD",
    });

    test("gross and net snapshots match the visible calculation and remain unchanged after transaction edits", async () => {
      const gross = (await createReport(db, {
        ...params(),
        revenueType: "gross",
      }))!;
      const net = (await createReport(db, {
        ...params(),
        revenueType: "net",
      }))!;
      const originalGross = await getChartDataByLinkId(db, gross.linkId!);
      const originalNet = await getChartDataByLinkId(db, net.linkId!);
      expect(originalGross.type).toBe("revenue");
      expect(originalNet.type).toBe("revenue");
      if (originalGross.type !== "revenue" || originalNet.type !== "revenue")
        throw new Error("Unexpected chart type");
      expect(originalGross.data.summary.currentTotal).toBe(120);
      expect(originalNet.data.summary.currentTotal).toBe(100);
      expect(originalGross.data).toEqual(
        JSON.parse(
          JSON.stringify(
            await getReports(db, { ...params(), revenueType: "gross" }),
          ),
        ),
      );
      await db
        .update(transactions)
        .set({ amount: 240 })
        .where(eq(transactions.id, fixture.own.transactionId));
      expect(
        (await getReports(db, { ...params(), revenueType: "gross" })).summary
          .currentTotal,
      ).toBe(240);
      expect(await getChartDataByLinkId(db, gross.linkId!)).toEqual(
        originalGross,
      );
      expect(await getChartDataByLinkId(db, net.linkId!)).toEqual(originalNet);
      await expect(
        db
          .update(reports)
          .set({ chartSnapshot: { version: 1, chart: {} } })
          .where(eq(reports.id, gross.id))
          .execute(),
      ).rejects.toMatchObject({
        cause: {
          code: "P0001",
          message: "Shared report snapshot and filters are immutable",
        },
      });
      expect(await getChartDataByLinkId(db, gross.linkId!)).toEqual(
        originalGross,
      );
    });

    test("expiry removes metadata as well as chart values and public DTO omits internal IDs", async () => {
      const report = (await createReport(db, params()))!;
      const metadata = await getReportByLinkId(db, report.linkId!);
      expect(metadata?.mode).toBe("snapshot");
      expect(metadata).not.toHaveProperty("teamId");
      expect(metadata).not.toHaveProperty("id");
      expect(metadata).not.toHaveProperty("createdBy");
      await db
        .update(reports)
        .set({ expireAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(reports.id, report.id));
      expect(await getReportByLinkId(db, report.linkId!)).toBeUndefined();
      await expect(getChartDataByLinkId(db, report.linkId!)).rejects.toThrow();
    });

    test("foreign revocation has no effect; owner revocation is immediate, irreversible and listed", async () => {
      const report = (await createReport(db, params()))!;
      expect(
        await revokeSharedReport(db, {
          id: report.id,
          teamId: fixture.other.teamId,
        }),
      ).toBeUndefined();
      expect(await getReportByLinkId(db, report.linkId!)).toBeDefined();
      await revokeSharedReport(db, {
        id: report.id,
        teamId: fixture.own.teamId,
      });
      expect(await getReportByLinkId(db, report.linkId!)).toBeUndefined();
      await expect(getChartDataByLinkId(db, report.linkId!)).rejects.toThrow();
      await expect(
        db
          .update(reports)
          .set({ revokedAt: null })
          .where(eq(reports.id, report.id))
          .execute(),
      ).rejects.toMatchObject({
        cause: {
          code: "P0001",
          message: "A revoked public report cannot be reopened",
        },
      });
      expect(
        (await listSharedReports(db, { teamId: fixture.own.teamId })).data.find(
          (row) => row.id === report.id,
        )?.revokedAt,
      ).toBeTruthy();
      expect(
        (await listSharedReports(db, { teamId: fixture.other.teamId })).data,
      ).toHaveLength(0);
    });

    test("legacy links keep explicitly live behavior rather than acquiring a fabricated historical snapshot", async () => {
      const linkId = randomUUID();
      await db.insert(reports).values({ ...params(), linkId });
      expect((await getReportByLinkId(db, linkId))?.mode).toBe("live");
      const before = await getChartDataByLinkId(db, linkId);
      await db
        .update(transactions)
        .set({ amount: 360 })
        .where(eq(transactions.id, fixture.own.transactionId));
      const after = await getChartDataByLinkId(db, linkId);
      expect(after).not.toEqual(before);
    });
  },
);
