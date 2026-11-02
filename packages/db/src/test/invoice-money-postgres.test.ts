import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  getInvoiceMoneyTemplate,
  InvoiceAmountError,
  InvoiceFinancialStateError,
} from "@midday/invoice/calculate";
import { eq } from "drizzle-orm";
import type { Database, TransactionClient } from "../client";
import { draftInvoice } from "../queries/invoices";
import { invoices, teams } from "../schema";
import { TenantResourceNotFoundError } from "../utils/tenant-ownership";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const rolledBack = Symbol("successful invoice test; roll back fixtures");
type Draft = Parameters<typeof draftInvoice>[1];

// Only the guarded disposable database, no providers or committed fixtures.
describe.skipIf(!isTestDatabaseAvailable())(
  "canonical invoice writes (PostgreSQL rollback fixtures)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);

    async function withInvoice(
      run: (tx: TransactionClient, input: Draft) => Promise<void>,
    ) {
      try {
        await db.transaction(async (tx) => {
          const teamId = randomUUID();
          await tx.insert(teams).values({
            id: teamId,
            inboxId: teamId,
            name: "Invoice money fixture",
          });
          await run(tx, {
            id: randomUUID(),
            teamId,
            userId: null,
            token: "local-invoice-money-fixture-token",
            invoiceNumber: "2026-001",
            issueDate: "2026-01-01T00:00:00.000Z",
            dueDate: "2026-02-01T00:00:00.000Z",
            template: { currency: "RUB" },
          });
          throw rolledBack;
        });
      } catch (error) {
        if (error !== rolledBack) throw error;
      }
    }

    test("persists canonical per-line tax, VAT and amount, ignoring contradictory client totals", async () => {
      await withInvoice(async (tx, input) => {
        const saved = await draftInvoice(tx, {
          ...input,
          amount: 888,
          subtotal: 666,
          vat: 777,
          tax: 999,
          discount: 0.2,
          template: {
            currency: "rub",
            includeVat: true,
            vatRate: 20,
            includeLineItemTax: true,
            taxRate: 99,
          },
          lineItems: [{ price: 10.05, quantity: 3, taxRate: 10 }],
        });
        expect(saved).toMatchObject({
          amount: 39,
          subtotal: 30.15,
          vat: 6.03,
          tax: 3.02,
          discount: 0.2,
          currency: "RUB",
          userId: null,
        });
        const [stored] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, input.id));
        expect(stored?.amount).toBe(39);
        expect(stored?.subtotal).toBe(30.15);
      });
    });

    test("new sparse API templates preserve legacy active-tax defaults and persist them explicitly", async () => {
      await withInvoice(async (tx, input) => {
        const saved = await draftInvoice(tx, {
          ...input,
          template: { currency: "RUB", taxRate: 10, vatRate: 10 },
          lineItems: [{ price: 100, quantity: 1 }],
        });
        expect(saved).toMatchObject({
          amount: 120,
          subtotal: 100,
          tax: 10,
          vat: 10,
        });
        expect(saved.template).toMatchObject({
          includeTax: true,
          includeVat: true,
          taxRate: 10,
          vatRate: 10,
        });
      });
    });

    for (const attached of [false, true]) {
      test(`sparse historical templates accept hydrated full metadata payload without repricing (intent=${attached})`, async () => {
        await withInvoice(async (tx, input) => {
          const sparseTemplate = { currency: "RUB", taxRate: 10, vatRate: 10 };
          const lineItems = [{ price: 0.05, quantity: 1 }];
          await tx.insert(invoices).values({
            ...input,
            template: sparseTemplate,
            lineItems,
            status: "unpaid",
            currency: "RUB",
            amount: 0.06,
            subtotal: 0.05,
            vat: 0.01,
            tax: 0.01,
            paymentIntentId: attached ? "pi_sparse_fixture" : null,
          });
          const saved = await draftInvoice(tx, {
            ...input,
            template: {
              ...getInvoiceMoneyTemplate(sparseTemplate),
              currency: sparseTemplate.currency,
            },
            lineItems,
            amount: 0.07,
            subtotal: 0.05,
            tax: 0.01,
            vat: 0.01,
            noteDetails: "metadata only",
          });
          expect(saved).toMatchObject({
            amount: 0.06,
            subtotal: 0.05,
            vat: 0.01,
            tax: 0.01,
            noteDetails: "metadata only",
          });
        });
      });
    }

    test("preserves the amount-only API contract and rounds supplied manual money", async () => {
      await withInvoice(async (tx, input) => {
        expect(
          (await draftInvoice(tx, { ...input, amount: 200.015, tax: 5 }))
            .amount,
        ).toBe(200.02);
        const updated = await draftInvoice(tx, { ...input, amount: 300 });
        expect(updated.amount).toBe(300);
        expect(updated.subtotal).toBe(295);
        expect(updated.tax).toBe(5);
        expect(updated.lineItems).toBeNull();
      });
    });

    test("omitted lines and template fields survive partial saves; incomplete rows remain draftable", async () => {
      await withInvoice(async (tx, input) => {
        await draftInvoice(tx, {
          ...input,
          lineItems: [{ quantity: 1 }],
          template: { currency: "RUB", taxRate: 10 },
        });
        const updated = await draftInvoice(tx, {
          ...input,
          template: {},
          noteDetails: "a note",
        });
        expect(updated).toMatchObject({
          amount: 0,
          tax: 0,
          currency: "RUB",
          lineItems: [{ quantity: 1 }],
        });
        expect(updated.template).toMatchObject({
          taxRate: 10,
          currency: "RUB",
        });
      });
    });

    test("metadata-only saves preserve the issued document; explicit unpaid financial edits require a correction", async () => {
      await withInvoice(async (tx, input) => {
        await tx.insert(invoices).values({
          ...input,
          amount: 101,
          subtotal: 90,
          tax: 1,
          vat: 0,
          status: "unpaid",
          currency: "RUB",
          template: { currency: "RUB", taxRate: 10 },
          lineItems: [{ price: 100, quantity: 1 }],
        });
        const noop = await draftInvoice(tx, {
          ...input,
          template: {},
          noteDetails: "updated note",
        });
        expect(noop).toMatchObject({
          amount: 101,
          subtotal: 90,
          tax: 1,
          status: "unpaid",
        });
        await expect(
          draftInvoice(tx, {
            ...input,
            template: {},
            lineItems: [{ price: 100, quantity: 2 }],
          }),
        ).rejects.toThrow(InvoiceFinancialStateError);
      });
    });

    for (const status of ["paid", "refunded", "canceled", "unpaid"] as const) {
      test(`rejects financial edits but preserves historical no-ops for ${status}${status === "unpaid" ? " with attached intent" : ""}`, async () => {
        await withInvoice(async (tx, input) => {
          await tx.insert(invoices).values({
            ...input,
            amount: 101,
            subtotal: 90,
            tax: 1,
            vat: 0,
            status,
            currency: "RUB",
            paymentIntentId: status === "unpaid" ? "pi_fixture" : null,
            template: { currency: "RUB", taxRate: 10 },
            lineItems: [{ price: 100, quantity: 1 }],
          });
          const noop = await draftInvoice(tx, {
            ...input,
            template: {},
            amount: 101,
            noteDetails: "note only",
          });
          expect(noop).toMatchObject({
            amount: 101,
            subtotal: 90,
            tax: 1,
            status,
          });
          const derivedNoop = await draftInvoice(tx, {
            ...input,
            subtotal: 100,
            amount: 110,
            tax: 10,
          });
          expect(derivedNoop).toMatchObject({
            amount: 101,
            subtotal: 90,
            tax: 1,
          });
          await expect(
            draftInvoice(tx, { ...input, discount: 1 }),
          ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
          await expect(
            draftInvoice(tx, { ...input, template: { currency: "EUR" } }),
          ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
          await expect(
            draftInvoice(tx, {
              ...input,
              lineItems: [{ price: 200, quantity: 1 }],
            }),
          ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
          const [unchanged] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, input.id));
          expect(unchanged).toMatchObject({
            amount: 101,
            subtotal: 90,
            tax: 1,
            currency: "RUB",
          });
        });
      });
    }

    for (const state of [
      "unpaid",
      "attached",
      "paid",
      "refunded",
      "canceled",
    ] as const) {
      test(`full editor payload preserves historical snapshot on note/date-only save (${state})`, async () => {
        await withInvoice(async (tx, input) => {
          const template = {
            currency: "RUB",
            includeTax: true,
            includeVat: true,
            taxRate: 10,
            vatRate: 10,
          };
          const lineItems = [
            { name: "Historical line", price: 0.05, quantity: 1 },
          ];
          await tx.insert(invoices).values({
            ...input,
            amount: 0.06,
            subtotal: 0.05,
            tax: 0.01,
            vat: 0.01,
            discount: 0,
            currency: "RUB",
            template,
            lineItems,
            status: state === "attached" ? "unpaid" : state,
            paymentIntentId:
              state === "attached" ? "pi_historical_fixture" : null,
          });
          // Shape sent by the old Summary mount effect + full-payload autosave:
          // new aggregate rounding produces .07 despite unchanged source data.
          const saved = await draftInvoice(tx, {
            ...input,
            template,
            lineItems,
            amount: 0.07,
            subtotal: 0.05,
            vat: 0.01,
            tax: 0.01,
            discount: 0,
            noteDetails: "Note edited without touching financial sources",
            dueDate: "2026-03-01T00:00:00.000Z",
          });
          expect(saved).toMatchObject({
            amount: 0.06,
            subtotal: 0.05,
            vat: 0.01,
            tax: 0.01,
            noteDetails: "Note edited without touching financial sources",
          });
        });
      });
    }

    test("amount-only payment-locked invoices still reject explicit manual monetary edits", async () => {
      await withInvoice(async (tx, input) => {
        await tx.insert(invoices).values({
          ...input,
          amount: 100,
          subtotal: 100,
          currency: "RUB",
          status: "unpaid",
          paymentIntentId: "pi_manual_fixture",
        });
        for (const change of [
          { amount: 101 },
          { subtotal: 99 },
          { tax: 1 },
          { vat: 1 },
        ]) {
          await expect(
            draftInvoice(tx, { ...input, ...change }),
          ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
        }
      });
    });

    test("rejects foreign invoice IDs without overwriting the other team's data", async () => {
      await withInvoice(async (tx, input) => {
        const otherTeamId = randomUUID();
        await tx.insert(teams).values({
          id: otherTeamId,
          inboxId: otherTeamId,
          name: "Other invoice team",
        });
        await tx.insert(invoices).values({
          ...input,
          teamId: otherTeamId,
          amount: 100,
          currency: "RUB",
        });
        await expect(
          draftInvoice(tx, { ...input, amount: 200 }),
        ).rejects.toBeInstanceOf(TenantResourceNotFoundError);
        const [unchanged] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, input.id));
        expect(unchanged).toMatchObject({ teamId: otherTeamId, amount: 100 });
      });
    });

    test("rejects overflow before creating a row", async () => {
      await withInvoice(async (tx, input) => {
        await expect(
          draftInvoice(tx, {
            ...input,
            lineItems: [{ price: 99999999, quantity: 2 }],
          }),
        ).rejects.toBeInstanceOf(InvoiceAmountError);
        expect(
          await tx.select().from(invoices).where(eq(invoices.id, input.id)),
        ).toHaveLength(0);
      });
    });
  },
);
