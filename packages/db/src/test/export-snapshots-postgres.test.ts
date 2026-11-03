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
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { financialRequestHash } from "../financial-job";
import {
  getOrCreateExportSnapshot,
  markSnapshotTransactionsExported,
  recordExportResult,
} from "../queries/export-snapshots";
import {
  customers,
  documents,
  invoiceProducts,
  invoices,
  trackerEntries,
  transactions,
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
  "versioned business exports (isolated PostgreSQL)",
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
    const request = (kind: "transactions" | "team" = "team") => ({
      teamId: fixture.own.teamId,
      kind,
      operationKey: financialRequestHash([fixture.own.teamId, kind]),
      request: { fixture: true },
      transactionIds: [fixture.own.transactionId],
    });
    test("exports complete invoice blocks, historical snapshots, products and unbounded tracker dates, excluding old archives and bearer secrets", async () => {
      // Issue the actual fixture row so the production trigger captures every
      // printable field and checks its financial identity at the SQL boundary.
      const [issued] = await db
        .update(invoices)
        .set({
          status: "unpaid",
          amount: 123,
          customerName: "Original issued name",
          paymentDetails: { fixture: "bank instructions" },
          fromDetails: { fixture: "seller" },
          customerDetails: { fixture: "buyer" },
          noteDetails: { fixture: "note" },
          topBlock: { fixture: "top" },
          bottomBlock: { fixture: "bottom" },
        })
        .where(eq(invoices.id, fixture.own.invoiceId))
        .returning({ documentSnapshot: invoices.documentSnapshot });
      const documentSnapshot = issued?.documentSnapshot;
      expect(documentSnapshot).toMatchObject({
        version: 1,
        source: "issued",
        document: {
          invoiceNumber: "FIXTURE-001",
          amount: 123,
          currency: "USD",
          customerId: fixture.own.customerId,
          customerName: "Original issued name",
          paymentDetails: { fixture: "bank instructions" },
          customerDetails: { fixture: "buyer" },
          fromDetails: { fixture: "seller" },
          noteDetails: { fixture: "note" },
          topBlock: { fixture: "top" },
          bottomBlock: { fixture: "bottom" },
        },
      });
      if (!documentSnapshot)
        throw new Error("Issued fixture document is missing");
      expect(Number.isFinite(Date.parse(documentSnapshot.capturedAt))).toBe(
        true,
      );
      // The export must retain the issued document even after live customer
      // details change; it must not reconstruct history from the current profile.
      await db
        .update(customers)
        .set({ name: "Current customer after issue" })
        .where(eq(customers.id, fixture.own.customerId));
      const productId = randomUUID();
      await db.insert(invoiceProducts).values({
        id: productId,
        teamId: fixture.own.teamId,
        name: "Fixture item",
        price: 12.5,
        currency: "USD",
      });
      for (const date of ["1899-01-01", "2099-01-01"])
        await db.insert(trackerEntries).values({
          teamId: fixture.own.teamId,
          projectId: fixture.own.projectId,
          date,
          duration: 3600,
        });
      const generatedId = randomUUID();
      await db.insert(documents).values({
        id: generatedId,
        teamId: fixture.own.teamId,
        name: "previous.zip",
        title: "Previous export",
        body: "",
        pathTokens: [fixture.own.teamId, "exports", "previous.zip"],
      });
      const snapshot = (await getOrCreateExportSnapshot(db, request()))
        .snapshot;
      const invoice = snapshot.tables.invoices!.find(
        (row) => row.id === fixture.own.invoiceId,
      )!;
      expect(invoice.document_snapshot).toEqual(documentSnapshot);
      expect(
        snapshot.tables.customers!.find(
          (row) => row.id === fixture.own.customerId,
        )?.name,
      ).toBe("Current customer after issue");
      expect(invoice.payment_details).toEqual({ fixture: "bank instructions" });
      expect(invoice.from_details).toEqual({ fixture: "seller" });
      expect(invoice.customer_details).toEqual({ fixture: "buyer" });
      expect(invoice.note_details).toEqual({ fixture: "note" });
      expect(invoice.top_block).toEqual({ fixture: "top" });
      expect(invoice.bottom_block).toEqual({ fixture: "bottom" });
      expect(invoice).not.toHaveProperty("token");
      expect(snapshot.tables.customers![0]).not.toHaveProperty("token");
      expect(JSON.stringify(snapshot)).not.toContain("original-invoice-token");
      expect(JSON.stringify(snapshot)).not.toContain("original-customer-token");
      expect(
        snapshot.tables.invoice_products!.some((row) => row.id === productId),
      ).toBe(true);
      expect(snapshot.tables.tracker_entries!.map((row) => row.date)).toEqual(
        expect.arrayContaining(["1899-01-01", "2099-01-01"]),
      );
      expect(
        snapshot.tables.documents!.some((row) => row.id === generatedId),
      ).toBe(false);
      expect(
        snapshot.tables.invoices!.some(
          (row) => row.id === fixture.other.invoiceId,
        ),
      ).toBe(false);
      expect(snapshot.consistency).toBe("repeatable-read");
    });
    test("two concurrent creators converge on one immutable export operation", async () => {
      const [a, b] = await Promise.all([
        getOrCreateExportSnapshot(db, request()),
        getOrCreateExportSnapshot(db, request()),
      ]);
      expect(a.id).toBe(b.id);
      expect(a.snapshot_hash).toBe(b.snapshot_hash);
      const count = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from export_snapshots where team_id=${fixture.own.teamId}::uuid`,
      );
      expect(count.rows[0]!.count).toBe(1);
    });

    test("retries retain the first snapshot despite later edits; changed request bytes conflict", async () => {
      const first = await getOrCreateExportSnapshot(db, request());
      await db
        .update(customers)
        .set({ name: "Changed after snapshot" })
        .where(eq(customers.id, fixture.own.customerId));
      const retry = await getOrCreateExportSnapshot(db, request());
      expect(retry.id).toBe(first.id);
      expect(retry.snapshot_hash).toBe(first.snapshot_hash);
      expect(retry.snapshot.tables.customers![0]!.name).toBe(
        "Original customer",
      );
      await expect(
        getOrCreateExportSnapshot(db, {
          ...request(),
          request: { fixture: "changed" },
        }),
      ).rejects.toThrow("conflict");
      await expect(
        db
          .execute(
            sql`update export_snapshots set snapshot='{}'::jsonb where id=${first.id}::uuid`,
          )
          .execute(),
      ).rejects.toMatchObject({
        cause: {
          code: "P0001",
          message: "Export snapshot identity and data are immutable",
        },
      });
      expect(
        (await getOrCreateExportSnapshot(db, request())).snapshot_hash,
      ).toBe(first.snapshot_hash);
    });
    test("partial export cannot mark missing rows or subsequently edited transaction data exported", async () => {
      const first = await getOrCreateExportSnapshot(
        db,
        request("transactions"),
      );
      expect(
        await markSnapshotTransactionsExported(db, {
          teamId: fixture.own.teamId,
          rows: first.snapshot.tables.transactions!,
          completeIds: [],
        }),
      ).toBe(0);
      expect(
        (
          await db
            .select()
            .from(transactions)
            .where(eq(transactions.id, fixture.own.transactionId))
        )[0]!.status,
      ).not.toBe("exported");
      await db
        .update(transactions)
        .set({ amount: 999 })
        .where(eq(transactions.id, fixture.own.transactionId));
      expect(
        await markSnapshotTransactionsExported(db, {
          teamId: fixture.own.teamId,
          rows: first.snapshot.tables.transactions!,
          completeIds: [fixture.own.transactionId],
        }),
      ).toBe(0);
      expect(
        (
          await db
            .select()
            .from(transactions)
            .where(eq(transactions.id, fixture.own.transactionId))
        )[0]!.status,
      ).not.toBe("exported");
    });
    test("selection identity includes IDs, handles empty arrays and excludes another tenant", async () => {
      const input = {
        ...request("transactions"),
        transactionIds: [
          fixture.own.transactionId,
          fixture.other.transactionId,
        ],
      };
      const selected = await getOrCreateExportSnapshot(db, input);
      expect(selected.snapshot.requestedTransactionIds).toHaveLength(2);
      expect(
        selected.snapshot.tables.transactions!.map((row) => row.id),
      ).toEqual([fixture.own.transactionId]);
      expect(selected.snapshot.transactionRows.map((row) => row.id)).toEqual([
        fixture.own.transactionId,
      ]);
      await expect(
        getOrCreateExportSnapshot(db, {
          ...input,
          transactionIds: [fixture.own.transactionId],
        }),
      ).rejects.toThrow("conflict");
      const empty = await getOrCreateExportSnapshot(db, {
        ...input,
        operationKey: financialRequestHash([fixture.own.teamId, "empty"]),
        transactionIds: [],
      });
      expect(empty.snapshot.tables.transactions).toEqual([]);
      expect(empty.snapshot.transactionRows).toEqual([]);
    });

    test("receipt is scoped to the tenant and a completed archive cannot be replaced by a later partial retry", async () => {
      const first = await getOrCreateExportSnapshot(
        db,
        request("transactions"),
      );
      await recordExportResult(db, {
        id: first.id,
        teamId: fixture.other.teamId,
        result: { status: "complete", fullPath: "foreign" },
      });
      expect(
        (await getOrCreateExportSnapshot(db, request("transactions"))).result,
      ).toBeNull();
      await recordExportResult(db, {
        id: first.id,
        teamId: fixture.own.teamId,
        result: { status: "complete", fullPath: "original" },
      });
      await recordExportResult(db, {
        id: first.id,
        teamId: fixture.own.teamId,
        result: { status: "partial", fullPath: "replacement" },
      });
      expect(
        (await getOrCreateExportSnapshot(db, request("transactions"))).result,
      ).toEqual({ status: "complete", fullPath: "original" });
    });
  },
);
