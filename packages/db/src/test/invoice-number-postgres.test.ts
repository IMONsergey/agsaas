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
import { InvoiceAmountError } from "@midday/invoice/calculate";
import type { Database } from "../client";
import { draftInvoice, getNextInvoiceNumber } from "../queries/invoices";
import { invoices } from "../schema";
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
  "invoice number concurrency (real PostgreSQL)",
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

    function input(
      overrides: Partial<Parameters<typeof draftInvoice>[1]> = {},
    ) {
      const own = fixture.own;
      return {
        id: own.invoiceId,
        teamId: own.teamId,
        userId: own.userId,
        customerId: own.customerId,
        invoiceNumber: "DOCUMENT-100",
        token: "fixture-public-token",
        issueDate: "2026-11-01T00:00:00.000Z",
        dueDate: "2026-12-01T00:00:00.000Z",
        template: { currency: "USD", paymentEnabled: true },
        lineItems: [{ name: "Design", unit: "hour", price: 100, quantity: 2 }],
        noteDetails: "original printable note",
        ...overrides,
      };
    }

    test("twelve concurrent reservations return distinct monotonic numbers in one team", async () => {
      const numbers = await Promise.all(
        Array.from({ length: 12 }, () =>
          getNextInvoiceNumber(db, fixture.own.teamId),
        ),
      );
      expect(new Set(numbers).size).toBe(12);
      const sorted = numbers
        .map((value) => Number(value.slice(4)))
        .sort((a, b) => a - b);
      expect(sorted).toEqual(
        Array.from({ length: 12 }, (_, index) => index + 2),
      );
      expect(await getNextInvoiceNumber(db, fixture.other.teamId)).toBe(
        "INV-0002",
      );
    });

    test("custom duplicate numbers lose safely under concurrency; DB constraint also rejects bypass", async () => {
      const results = await Promise.allSettled([
        draftInvoice(
          db,
          input({ id: randomUUID(), invoiceNumber: "SAME-200" }),
        ),
        draftInvoice(
          db,
          input({ id: randomUUID(), invoiceNumber: "SAME-200" }),
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failed = results.find((result) => result.status === "rejected");
      expect(
        failed?.status === "rejected" ? failed.reason : null,
      ).toBeInstanceOf(InvoiceAmountError);
      await expect(
        db
          .insert(invoices)
          .values({ teamId: fixture.own.teamId, invoiceNumber: " SAME-200 " })
          .execute(),
      ).rejects.toThrow();
      await db
        .insert(invoices)
        .values({ teamId: fixture.other.teamId, invoiceNumber: "SAME-200" });
    });

    test("a custom suffix outside int32 is incremented without overflow or precision loss", async () => {
      await db.insert(invoices).values({
        teamId: fixture.own.teamId,
        invoiceNumber: "CUSTOM-900719925474099312345",
      });
      expect(await getNextInvoiceNumber(db, fixture.own.teamId)).toBe(
        "INV-900719925474099312346",
      );
    });

    test("a legal long custom identifier cannot exhaust the generated display-number namespace", async () => {
      await db
        .insert(invoices)
        .values({ teamId: fixture.own.teamId, invoiceNumber: "9".repeat(120) });
      expect(await getNextInvoiceNumber(db, fixture.own.teamId)).toBe(
        "INV-0002",
      );
    });
  },
);
