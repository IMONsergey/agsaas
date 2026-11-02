import { describe, expect, test } from "bun:test";
import { hasInvoiceFinancialChanges } from "@midday/invoice/calculate";
import {
  getInvoiceEditorSummary,
  getInvoiceEditorTemplate,
} from "./summary-values";

const historical = {
  id: "invoice-a",
  status: "unpaid",
  amount: 0.06,
  subtotal: 0.05,
  vat: 0.01,
  tax: 0.01,
  discount: 0,
  template: {
    currency: "RUB",
    includeTax: true,
    includeVat: true,
    taxRate: 10,
    vatRate: 10,
  },
  lineItems: [{ name: "Service", price: 0.05, quantity: 1 }],
  dueDate: "2026-01-01",
  noteDetails: "Original note",
};

describe("invoice editor summary snapshot policy", () => {
  test("existing sparse financial templates use stable calculator defaults, not today's team settings", () => {
    const sparse = { currency: "USD", taxRate: 10, vatRate: 10 };
    const defaults = {
      currency: "EUR",
      includeTax: false,
      includeVat: false,
      taxRate: 99,
      vatRate: 50,
      title: "Team title",
    };
    const template = getInvoiceEditorTemplate(defaults, {
      template: sparse,
      currency: "USD",
    });
    expect(template).toMatchObject({
      currency: "USD",
      includeTax: true,
      includeVat: true,
      taxRate: 10,
      vatRate: 10,
      title: "Team title",
    });
    const loaded = { ...historical, template: sparse };
    const fullEditorPayload = { ...loaded, template };
    expect(hasInvoiceFinancialChanges(loaded, fullEditorPayload)).toBe(false);
    expect(
      getInvoiceEditorSummary(loaded, fullEditorPayload).values.amount,
    ).toBe(0.06);
    // New drafts still use explicitly chosen team/template settings.
    expect(getInvoiceEditorTemplate(defaults)).toMatchObject({
      includeTax: false,
      includeVat: false,
      taxRate: 99,
    });
  });
  for (const status of [
    "unpaid",
    "overdue",
    "paid",
    "refunded",
    "canceled",
    "scheduled",
  ]) {
    test(`mount and metadata-only full payload preserve ${status} totals`, () => {
      const initial = { ...historical, status };
      const result = getInvoiceEditorSummary(initial, {
        ...initial,
        // Old mounted Summary could put today's calculation into full autosave.
        amount: 0.07,
      });
      expect(result.preserveSnapshot).toBe(true);
      expect(result.display.total).toBe(0.06);
      expect(result.values).toEqual({
        amount: 0.06,
        subtotal: 0.05,
        vat: 0.01,
        tax: 0.01,
        discount: 0,
      });
    });
  }

  test("note, due-date and line-description changes are not financial source changes", () => {
    const current = {
      ...historical,
      noteDetails: "New note",
      dueDate: "2026-03-01",
      lineItems: [{ ...historical.lineItems[0]!, name: "New description" }],
    };
    expect(getInvoiceEditorSummary(historical, current).values.amount).toBe(
      0.06,
    );
  });

  test("an actual line source edit recalculates and reverting restores the loaded snapshot", () => {
    const changed = { ...historical, lineItems: [{ price: 0.1, quantity: 1 }] };
    const recalculated = getInvoiceEditorSummary(historical, changed);
    expect(recalculated.preserveSnapshot).toBe(false);
    expect(recalculated.values.amount).toBe(0.12);
    const reverted = getInvoiceEditorSummary(historical, {
      ...historical,
      ...recalculated.values,
    });
    expect(reverted.preserveSnapshot).toBe(true);
    expect(reverted.display.total).toBe(0.06);
    expect(reverted.values.amount).toBe(0.06);
  });

  test("form reset/switch uses the newly supplied default snapshot, not the first mounted invoice", () => {
    expect(getInvoiceEditorSummary(historical, historical).display.total).toBe(
      0.06,
    );
    const reset = { ...historical, id: "invoice-b", amount: 0.09 };
    expect(getInvoiceEditorSummary(reset, reset).display.total).toBe(0.09);
    const refetched = { ...reset, amount: 0.08 };
    expect(getInvoiceEditorSummary(refetched, refetched).display.total).toBe(
      0.08,
    );
  });

  test("drafts calculate on mount while null historical components remain null in form values", () => {
    const draft = { ...historical, status: "draft" };
    expect(getInvoiceEditorSummary(draft, draft).values.amount).toBe(0.07);
    const legacy = { ...historical, subtotal: null, discount: null };
    expect(getInvoiceEditorSummary(legacy, legacy).values).toMatchObject({
      subtotal: null,
      discount: null,
      amount: 0.06,
    });
  });

  test("manual amount-only invoices are not zeroed by the editor", () => {
    const manual = {
      ...historical,
      lineItems: [],
      amount: 200,
      subtotal: 180,
      vat: 20,
      tax: 0,
    };
    expect(getInvoiceEditorSummary(manual, manual).display.total).toBe(200);
    const edited = getInvoiceEditorSummary(manual, { ...manual, amount: 300 });
    expect(edited.preserveSnapshot).toBe(false);
    expect(edited.values).toMatchObject({
      amount: 300,
      subtotal: 280,
      vat: 20,
    });
  });

  test("rate/flag/currency/discount changes trigger the same source-intent policy as the server", () => {
    for (const current of [
      { ...historical, discount: 0.01 },
      { ...historical, template: { ...historical.template, currency: "USD" } },
      { ...historical, template: { ...historical.template, taxRate: 20 } },
      {
        ...historical,
        template: { ...historical.template, includeVat: false },
      },
    ])
      expect(
        getInvoiceEditorSummary(historical, current).preserveSnapshot,
      ).toBe(false);
  });
});
