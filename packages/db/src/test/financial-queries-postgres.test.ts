import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database, TransactionClient } from "../client";
import { getCustomerById, getCustomers } from "../queries/customers";
import { getTaxSummary } from "../queries/reports";
import {
  customers,
  customerTags,
  exchangeRates,
  invoices,
  tags,
  teams,
  trackerProjects,
  transactionCategories,
  transactions,
} from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

type Fixture = { teamId: string; otherTeamId: string; customerId: string };
const rolledBack = Symbol("successful financial test; roll back all fixtures");

async function addCustomer(
  tx: TransactionClient,
  teamId: string,
  name = "Customer",
) {
  const id = randomUUID();
  await tx.insert(customers).values({
    id,
    teamId,
    name,
    email: `${id}@example.test`,
  });
  return id;
}

async function addInvoice(
  tx: TransactionClient,
  fixture: Fixture,
  overrides: Partial<typeof invoices.$inferInsert> = {},
) {
  await tx.insert(invoices).values({
    id: randomUUID(),
    teamId: fixture.teamId,
    customerId: fixture.customerId,
    amount: 100,
    currency: "RUB",
    status: "paid",
    issueDate: "2026-01-15T00:00:00.000Z",
    ...overrides,
  });
}

async function addTransaction(
  tx: TransactionClient,
  fixture: Fixture,
  overrides: Partial<typeof transactions.$inferInsert> = {},
) {
  const id = randomUUID();
  await tx.insert(transactions).values({
    id,
    internalId: id,
    teamId: fixture.teamId,
    name: "Financial query fixture",
    date: "2026-01-15",
    amount: -120,
    currency: "RUB",
    method: "payment",
    status: "posted",
    internal: false,
    taxAmount: 20,
    taxType: "vat",
    ...overrides,
  });
}

async function setRate(
  tx: TransactionClient,
  base: string,
  target: string,
  rate: number,
) {
  const updatedAt = "2026-01-15T00:00:00.000Z";
  // Only the guarded disposable DB, inside a transaction that always rolls back.
  await tx
    .insert(exchangeRates)
    .values({ base, target, rate, updatedAt })
    .onConflictDoUpdate({
      target: [exchangeRates.base, exchangeRates.target],
      set: { rate, updatedAt },
    });
}

function taxParams(teamId: string, type: "paid" | "collected" = "paid") {
  return {
    teamId,
    type,
    from: "2026-01-01",
    to: "2026-01-31",
    currency: "RUB",
  };
}

// Real query functions and PostgreSQL, no fake aggregation. No TRUNCATE, DELETE,
// DDL, providers or committed fixtures. The shared URL guard restricts this to
// an explicitly configured local/disposable midday_test database. Run separately
// from the legacy calculation suite, which truncates shared tables.
describe.skipIf(!isTestDatabaseAvailable())(
  "financial queries (PostgreSQL rollback fixtures)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);

    async function withFixture(
      run: (tx: TransactionClient, fixture: Fixture) => Promise<void>,
      baseCurrency: string | null = "RUB",
    ) {
      try {
        await db.transaction(async (tx) => {
          const teamId = randomUUID();
          const otherTeamId = randomUUID();
          await tx.insert(teams).values([
            {
              id: teamId,
              name: "Financial fixture",
              inboxId: teamId,
              baseCurrency,
            },
            {
              id: otherTeamId,
              name: "Other fixture",
              inboxId: otherTeamId,
              baseCurrency: "RUB",
            },
          ]);
          const customerId = await addCustomer(tx, teamId);
          await run(tx, { teamId, otherTeamId, customerId });
          throw rolledBack;
        });
      } catch (error) {
        if (error !== rolledBack) throw error;
      }
    }

    test("independent invoice/project/tag collections neither multiply nor deduplicate equal amounts", async () => {
      await withFixture(async (tx, fixture) => {
        for (const [status, amount] of [
          ["paid", 100],
          ["paid", 100],
          ["unpaid", 40],
          ["overdue", 60],
          ["draft", 999],
          ["canceled", 888],
          ["scheduled", 777],
          ["refunded", 666],
        ] as const) {
          await addInvoice(tx, fixture, { status, amount });
        }
        await tx.insert(trackerProjects).values(
          ["A", "B"].map((name) => ({
            teamId: fixture.teamId,
            customerId: fixture.customerId,
            name,
          })),
        );
        const tagIds = [randomUUID(), randomUUID()];
        await tx.insert(tags).values(
          tagIds.map((id, index) => ({
            id,
            teamId: fixture.teamId,
            name: `Tag ${index}`,
          })),
        );
        await tx.insert(customerTags).values(
          tagIds.map((tagId) => ({
            tagId,
            customerId: fixture.customerId,
            teamId: fixture.teamId,
          })),
        );

        const result = await getCustomers(tx, { teamId: fixture.teamId });
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toMatchObject({
          id: fixture.customerId,
          invoiceCount: 8,
          projectCount: 2,
          totalRevenue: 200,
          outstandingAmount: 100,
          invoiceCurrency: "RUB",
        });
        expect(result.data[0]?.tags).toHaveLength(2);
        const detail = await getCustomerById(tx, {
          teamId: fixture.teamId,
          id: fixture.customerId,
        });
        expect(detail).toMatchObject({ invoiceCount: 8, projectCount: 2 });
        expect(detail?.tags).toHaveLength(2);
      });
    });

    test("customers without related rows retain zero counts/totals and empty tags", async () => {
      await withFixture(async (tx, fixture) => {
        const result = await getCustomers(tx, { teamId: fixture.teamId });
        expect(result.data[0]).toMatchObject({
          invoiceCount: 0,
          projectCount: 0,
          totalRevenue: 0,
          outstandingAmount: 0,
          tags: [],
          lastInvoiceDate: null,
        });
        expect(
          await getCustomerById(tx, {
            teamId: fixture.otherTeamId,
            id: fixture.customerId,
          }),
        ).toBeUndefined();
      });
    });

    test("mixed currencies use the team's base currency; own-currency invoices need no FX rate", async () => {
      await withFixture(async (tx, fixture) => {
        await setRate(tx, "USD", "RUB", 90);
        await setRate(tx, "EUR", "RUB", 100);
        await addInvoice(tx, fixture, { amount: 100 });
        await addInvoice(tx, fixture, { amount: 10, currency: "USD" });
        await addInvoice(tx, fixture, {
          amount: 20,
          currency: "EUR",
          status: "unpaid",
        });
        await addInvoice(tx, fixture, { amount: 50, status: "overdue" });
        const result = await getCustomers(tx, { teamId: fixture.teamId });
        expect(result.data[0]).toMatchObject({
          totalRevenue: 1000,
          outstandingAmount: 2050,
          invoiceCurrency: "RUB",
          invoiceCount: 4,
        });
      });
    });

    test("missing FX never produces a partial paid total or hides a complete outstanding total", async () => {
      await withFixture(async (tx, fixture) => {
        await addInvoice(tx, fixture, { amount: 100 });
        await addInvoice(tx, fixture, { currency: "XTS", amount: 10 });
        await addInvoice(tx, fixture, { status: "unpaid", amount: 40 });
        const result = await getCustomers(tx, { teamId: fixture.teamId });
        expect(result.data[0]?.totalRevenue).toBeUndefined();
        expect(result.data[0]?.outstandingAmount).toBe(40);
        expect(result.data[0]?.invoiceCurrency).toBe("RUB");
        expect(JSON.parse(JSON.stringify(result.data[0]))).not.toHaveProperty(
          "totalRevenue",
        );
      });
    });

    for (const currency of [null, "", "rub", "RUBLE", "XTS"]) {
      test(`invalid/unconvertible outstanding currency ${String(currency)} does not hide valid paid money`, async () => {
        await withFixture(async (tx, fixture) => {
          await addInvoice(tx, fixture);
          await addInvoice(tx, fixture, { status: "unpaid", currency });
          const result = await getCustomers(tx, { teamId: fixture.teamId });
          expect(result.data[0]?.totalRevenue).toBe(100);
          expect(result.data[0]?.outstandingAmount).toBeUndefined();
        });
      });
    }

    for (const rate of [0, -1]) {
      test(`non-positive invoice FX rate ${rate} is incomplete rather than a zero/reversed total`, async () => {
        await withFixture(async (tx, fixture) => {
          await setRate(tx, "USD", "RUB", rate);
          await addInvoice(tx, fixture, { currency: "USD" });
          expect(
            (await getCustomers(tx, { teamId: fixture.teamId })).data[0]
              ?.totalRevenue,
          ).toBeUndefined();
        });
      });
    }

    test("a missing base currency falls back only to the single financial source currency", async () => {
      await withFixture(async (tx, fixture) => {
        await addInvoice(tx, fixture, { currency: "EUR", amount: 50 });
        await addInvoice(tx, fixture, {
          currency: "RUB",
          status: "draft",
          amount: 999,
        });
        expect(
          (await getCustomers(tx, { teamId: fixture.teamId })).data[0],
        ).toMatchObject({ totalRevenue: 50, invoiceCurrency: "EUR" });
        const otherCustomerId = await addCustomer(tx, fixture.teamId);
        await addInvoice(tx, fixture, {
          customerId: otherCustomerId,
          currency: "USD",
          amount: 60,
        });
        const mixed = await getCustomers(tx, { teamId: fixture.teamId });
        expect(mixed.data).toHaveLength(2);
        for (const customer of mixed.data) {
          expect(customer.totalRevenue).toBeUndefined();
          expect(customer.invoiceCurrency).toBeNull();
        }
      }, null);
    });

    for (const [sortField, status, metric] of [
      ["total_revenue", "paid", "totalRevenue"],
      ["outstanding", "unpaid", "outstandingAmount"],
    ] as const) {
      test(`${sortField} pagination sorts complete totals first in both directions`, async () => {
        await withFixture(async (tx, fixture) => {
          await addInvoice(tx, fixture, { status });
          const emptyId = await addCustomer(tx, fixture.teamId, "Empty");
          const largerId = await addCustomer(tx, fixture.teamId, "Larger");
          const missingId = await addCustomer(tx, fixture.teamId, "Incomplete");
          await addInvoice(tx, fixture, {
            customerId: largerId,
            status,
            amount: 200,
          });
          await addInvoice(tx, fixture, {
            customerId: missingId,
            status,
            currency: "XTS",
          });
          for (const direction of ["asc", "desc"] as const) {
            const first = await getCustomers(tx, {
              teamId: fixture.teamId,
              sort: [sortField, direction],
              pageSize: 2,
            });
            const second = await getCustomers(tx, {
              teamId: fixture.teamId,
              sort: [sortField, direction],
              pageSize: 2,
              cursor: first.meta.cursor,
            });
            const rows = [...first.data, ...second.data];
            expect(rows.map((row) => row.id)).toEqual(
              direction === "asc"
                ? [emptyId, fixture.customerId, largerId, missingId]
                : [largerId, fixture.customerId, emptyId, missingId],
            );
            expect(rows.at(-1)?.[metric]).toBeUndefined();
            expect(new Set(rows.map((row) => row.id)).size).toBe(4);
          }
        });
      });
    }

    test("numeric-prefix/name/tax-ID searches filter instead of returning every customer", async () => {
      await withFixture(async (tx, fixture) => {
        const namedId = await addCustomer(tx, fixture.teamId, "7701 Example");
        const taxId = randomUUID();
        await tx.insert(customers).values({
          id: taxId,
          teamId: fixture.teamId,
          name: "Tax identity",
          email: "tax@example.test",
          vatNumber: "99887766",
        });
        await addCustomer(tx, fixture.otherTeamId, "7701 Example");
        expect(
          (
            await getCustomers(tx, { teamId: fixture.teamId, q: "7701" })
          ).data.map((row) => row.id),
        ).toEqual([namedId]);
        expect(
          (
            await getCustomers(tx, { teamId: fixture.teamId, q: "998877" })
          ).data.map((row) => row.id),
        ).toEqual([taxId]);
        expect(
          (
            await getCustomers(tx, {
              teamId: fixture.teamId,
              q: "012345-no-match",
            })
          ).data,
        ).toEqual([]);
      });
    });

    test("legacy cross-team child links do not enter own-team counts, sums or tags", async () => {
      await withFixture(async (tx, fixture) => {
        await addInvoice(tx, fixture);
        await addInvoice(tx, fixture, {
          teamId: fixture.otherTeamId,
          amount: 999,
        });
        await tx.insert(trackerProjects).values({
          teamId: fixture.otherTeamId,
          customerId: fixture.customerId,
          name: "Foreign project",
        });
        const foreignTagId = randomUUID();
        await tx.insert(tags).values({
          id: foreignTagId,
          teamId: fixture.otherTeamId,
          name: "Foreign tag",
        });
        await tx.insert(customerTags).values({
          teamId: fixture.teamId,
          customerId: fixture.customerId,
          tagId: foreignTagId,
        });
        expect(
          (await getCustomers(tx, { teamId: fixture.teamId })).data[0],
        ).toMatchObject({
          invoiceCount: 1,
          projectCount: 0,
          totalRevenue: 100,
          tags: [],
        });
        expect(
          await getCustomerById(tx, {
            teamId: fixture.teamId,
            id: fixture.customerId,
          }),
        ).toMatchObject({ invoiceCount: 1, projectCount: 0, tags: [] });
      });
    });

    for (const [label, taxAmount, taxRate, categoryRate, expected] of [
      ["fixed amount beats both rates", 20, 10, 25, 20],
      ["fixed zero beats both rates", 0, 20, 25, 0],
      ["own zero rate beats category", null, 0, 20, 0],
      ["own percentage beats category", null, 10, 20, 10.91],
      ["category is the last fallback", null, null, 20, 20],
    ] as const) {
      test(`tax precedence: ${label}`, async () => {
        await withFixture(async (tx, fixture) => {
          await tx.insert(transactionCategories).values({
            id: randomUUID(),
            teamId: fixture.teamId,
            slug: "software",
            name: "Software",
            taxRate: categoryRate,
            taxType: "vat",
          });
          await addTransaction(tx, fixture, {
            taxAmount,
            taxRate,
            categorySlug: "software",
          });
          const result = await getTaxSummary(tx, taxParams(fixture.teamId));
          expect(result.summary).toMatchObject({
            totalTaxAmount: expected,
            totalTransactionAmount: 120,
            totalTransactions: 1,
            currency: "RUB",
          });
        });
      });
    }

    test("a fixed amount without its own rate does not inherit the category percentage", async () => {
      await withFixture(async (tx, fixture) => {
        await tx.insert(transactionCategories).values({
          id: randomUUID(),
          teamId: fixture.teamId,
          slug: "software",
          name: "Software",
          taxRate: 25,
        });
        await addTransaction(tx, fixture, {
          categorySlug: "software",
          taxRate: null,
          taxAmount: 7,
        });
        const result = await getTaxSummary(tx, taxParams(fixture.teamId));
        expect(result.summary.totalTaxAmount).toBe(7);
        expect(result.result[0]?.avg_tax_rate).toBe(0);
      });
    });

    test("signed fixed tax values follow cash direction; zero-amount operations are excluded", async () => {
      await withFixture(async (tx, fixture) => {
        for (const [amount, taxAmount] of [
          [-120, 20],
          [-60, -10],
          [120, -20],
          [60, 10],
          [0, 5],
        ]) {
          await addTransaction(tx, fixture, { amount, taxAmount });
        }
        for (const type of ["paid", "collected"] as const) {
          const result = await getTaxSummary(
            tx,
            taxParams(fixture.teamId, type),
          );
          expect(result.summary).toMatchObject({
            totalTaxAmount: 30,
            totalTransactionAmount: 180,
            totalTransactions: 2,
            type,
          });
        }
      });
    });

    for (const [label, currency, baseCurrency, baseAmount, expected] of [
      ["stored conversion wins over latest FX", "USD", "RUB", -12000, 2000],
      ["current FX is used without stored conversion", "USD", null, null, 1800],
      ["null stored conversion uses current FX", "USD", "RUB", null, 1800],
      ["own currency ignores unrelated base amount", "RUB", "USD", -2, 20],
    ] as const) {
      test(`fixed tax currency: ${label}`, async () => {
        await withFixture(async (tx, fixture) => {
          await setRate(tx, "USD", "RUB", 90);
          await addTransaction(tx, fixture, {
            currency,
            baseCurrency,
            baseAmount,
          });
          const result = await getTaxSummary(tx, taxParams(fixture.teamId));
          expect(result.summary.totalTaxAmount).toBe(expected);
          expect(result.summary.totalTransactionAmount).toBe(expected * 6);
          expect(result.summary.currency).toBe("RUB");
        });
      });
    }

    test("missing or non-positive FX does not silently mix original-currency tax into RUB", async () => {
      await withFixture(async (tx, fixture) => {
        await setRate(tx, "USD", "RUB", -1);
        await setRate(tx, "EUR", "RUB", 0);
        await addTransaction(tx, fixture);
        for (const currency of ["XTS", "USD", "EUR"]) {
          await addTransaction(tx, fixture, {
            currency,
            baseCurrency: "RUB",
            baseAmount: null,
          });
        }
        expect(
          (await getTaxSummary(tx, taxParams(fixture.teamId))).summary,
        ).toMatchObject({
          totalTaxAmount: 20,
          totalTransactionAmount: 120,
          totalTransactions: 1,
        });
        expect(
          (await getTaxSummary(tx, taxParams(fixture.teamId, "collected")))
            .summary.totalTransactions,
        ).toBe(0);
      });
    });

    test("teamless base-currency default converts real USD amounts instead of relabeling raw RUB", async () => {
      await withFixture(async (tx, fixture) => {
        await setRate(tx, "RUB", "USD", 0.01);
        await addTransaction(tx, fixture);
        const result = await getTaxSummary(tx, {
          teamId: fixture.teamId,
          type: "paid",
          from: "2026-01-01",
          to: "2026-01-31",
        });
        expect(result.summary).toMatchObject({
          currency: "USD",
          totalTaxAmount: 0.2,
          totalTransactionAmount: 1.2,
        });
      }, null);
    });

    test("tax summary keeps tenant, direction, date, internal and excluded filters", async () => {
      await withFixture(async (tx, fixture) => {
        await addTransaction(tx, fixture);
        await tx.insert(transactionCategories).values({
          id: randomUUID(),
          teamId: fixture.teamId,
          slug: "excluded-fixture",
          name: "Excluded",
          excluded: true,
        });
        for (const overrides of [
          { teamId: fixture.otherTeamId },
          { amount: 120 },
          { internal: true },
          { status: "excluded" as const },
          { date: "2026-02-01" },
          { categorySlug: "excluded-fixture" },
        ]) {
          await addTransaction(tx, fixture, overrides);
        }
        expect(
          (await getTaxSummary(tx, taxParams(fixture.teamId))).summary,
        ).toMatchObject({ totalTaxAmount: 20, totalTransactions: 1 });
      });
    });
  },
);
