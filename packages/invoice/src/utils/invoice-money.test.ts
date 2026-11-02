import { describe, expect, test } from "bun:test";
import {
  calculateInvoiceAmounts,
  calculateLineItemTotal,
  calculateTotal,
  getInvoiceMoneyTemplate,
  getInvoiceSnapshotAmounts,
  hasInvoiceFinancialChanges,
  InvoiceAmountError,
  validateInvoiceMoney,
} from "./calculate";

describe("canonical invoice money", () => {
  test("sparse API templates retain legacy active-tax defaults, while explicit UI opt-out remains false", () => {
    const sparse = { currency: "USD", taxRate: 10, vatRate: 10 };
    expect(
      calculateInvoiceAmounts({
        template: sparse,
        lineItems: [{ price: 100, quantity: 1 }],
      }),
    ).toMatchObject({ amount: 120, tax: 10, vat: 10 });
    expect(getInvoiceMoneyTemplate(sparse)).toMatchObject({
      includeTax: true,
      includeVat: true,
      includeLineItemTax: false,
      taxRate: 10,
      vatRate: 10,
    });
    expect(
      hasInvoiceFinancialChanges(
        { template: sparse, lineItems: [{ price: 100, quantity: 1 }] },
        {
          template: getInvoiceMoneyTemplate(sparse),
          lineItems: [{ price: 100, quantity: 1 }],
          amount: 120,
        },
      ),
    ).toBe(false);
    expect(
      calculateInvoiceAmounts({
        template: { ...sparse, includeTax: false, includeVat: false },
        lineItems: [{ price: 100, quantity: 1 }],
      }),
    ).toMatchObject({ amount: 100, tax: 0, vat: 0 });
  });
  test("uses exact decimal multiplication and PostgreSQL half-away-from-zero rounding", () => {
    expect(calculateLineItemTotal({ price: 1.005, quantity: 1 })).toBe(1.01);
    expect(calculateLineItemTotal({ price: -1.005, quantity: 1 })).toBe(-1.01);
    expect(
      calculateTotal({ lineItems: [{ price: 0.1, quantity: 3 }] }).total,
    ).toBe(0.3);
    expect(
      calculateTotal({ lineItems: [{ price: 1e-7, quantity: 100000 }] }).total,
    ).toBe(0.01);
  });

  test("rounds each aggregate once and totals its rounded summary components", () => {
    expect(
      calculateTotal({
        lineItems: [{ price: 0.05, quantity: 1 }],
        taxRate: 10,
        vatRate: 10,
      }),
    ).toEqual({ subTotal: 0.05, vat: 0.01, tax: 0.01, total: 0.07 });
    // Aggregate rounding, not separately rounded line extensions.
    expect(
      calculateTotal({
        lineItems: [
          { price: 0.005, quantity: 1 },
          { price: 0.005, quantity: 1 },
        ],
      }).subTotal,
    ).toBe(0.01);
    expect(
      calculateInvoiceAmounts({ amount: 20, discount: 1.005 }),
    ).toMatchObject({
      amount: 20,
      discount: 1.01,
    });
  });

  test("itemized writes derive VAT, per-line tax and total instead of trusting client totals", () => {
    expect(
      calculateInvoiceAmounts({
        amount: 1,
        vat: 2,
        tax: 3,
        discount: 10,
        template: {
          includeVat: true,
          vatRate: 20,
          includeTax: false,
          includeLineItemTax: true,
          taxRate: 99,
        },
        lineItems: [
          { price: 100, quantity: 2, taxRate: 10 },
          { price: 50, quantity: 1, taxRate: 25 },
        ],
      }),
    ).toEqual({
      amount: 322.5,
      subtotal: 250,
      vat: 50,
      tax: 32.5,
      discount: 10,
    });
  });

  test("disabled VAT and tax remain disabled; zero line tax is not replaced by template tax", () => {
    expect(
      calculateInvoiceAmounts({
        template: {
          includeVat: false,
          vatRate: 20,
          includeTax: false,
          taxRate: 10,
        },
        lineItems: [{ price: 100, quantity: 1 }],
      }),
    ).toMatchObject({ amount: 100, vat: 0, tax: 0 });
    expect(
      calculateInvoiceAmounts({
        template: { includeLineItemTax: true, taxRate: 20 },
        lineItems: [{ price: 100, quantity: 1, taxRate: 0 }],
      }).tax,
    ).toBe(0);
  });

  test("manual/amount-only API drafts preserve explicit totals with no items or an empty list", () => {
    const manual = { amount: 199.995, tax: 5, vat: 20, discount: null };
    expect(calculateInvoiceAmounts(manual)).toEqual({
      amount: 200,
      subtotal: 175,
      tax: 5,
      vat: 20,
      discount: null,
    });
    expect(calculateInvoiceAmounts({ ...manual, lineItems: [] })).toEqual({
      amount: 200,
      subtotal: 175,
      tax: 5,
      vat: 20,
      discount: null,
    });
    expect(calculateInvoiceAmounts({ amount: null })).toMatchObject({
      amount: null,
    });
    expect(calculateInvoiceAmounts({}).amount).toBeUndefined();
  });

  test("subtotal is canonical on writes, finite and in range even when client-supplied", () => {
    expect(
      calculateInvoiceAmounts({ amount: 200, tax: 10, subtotal: 1 }).subtotal,
    ).toBe(190);
    expect(calculateInvoiceAmounts({ subtotal: 12.345 }).subtotal).toBe(12.35);
    expect(
      calculateInvoiceAmounts({
        subtotal: 888,
        lineItems: [{ price: 10, quantity: 2 }],
      }).subtotal,
    ).toBe(20);
    expect(() =>
      calculateInvoiceAmounts({
        subtotal: Number.NaN,
        lineItems: [{ price: 1, quantity: 1 }],
      }),
    ).toThrow(InvoiceAmountError);
    expect(() => calculateInvoiceAmounts({ subtotal: 100000000 })).toThrow(
      InvoiceAmountError,
    );
    expect(() =>
      calculateInvoiceAmounts({
        lineItems: [{ price: 99999999, quantity: 2 }],
        discount: 99999999,
      }),
    ).toThrow(InvoiceAmountError);
  });

  test("incomplete draft rows are valid and signed credit lines still work", () => {
    expect(
      calculateInvoiceAmounts({
        lineItems: [{}, { price: 100 }, { quantity: 3 }],
        amount: 100,
      }),
    ).toMatchObject({ amount: 0, vat: 0, tax: 0 });
    expect(
      calculateInvoiceAmounts({
        lineItems: [{ price: -10, quantity: 1 }],
        template: { taxRate: 10 },
      }),
    ).toMatchObject({ amount: -11, tax: -1 });
  });

  for (const invalid of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    test(`rejects nonfinite values, including overwritten client totals (${invalid})`, () => {
      expect(() =>
        calculateInvoiceAmounts({
          amount: invalid,
          lineItems: [{ price: 1, quantity: 1 }],
        }),
      ).toThrow(InvoiceAmountError);
      expect(() =>
        calculateInvoiceAmounts({
          lineItems: [{ price: invalid, quantity: 0 }],
        }),
      ).toThrow(InvoiceAmountError);
      expect(() =>
        validateInvoiceMoney({
          template: { taxRate: invalid, includeTax: false },
        }),
      ).toThrow(InvoiceAmountError);
    });
  }

  test("rejects stored-column overflow before persistence and permits the exact boundary", () => {
    expect(calculateInvoiceAmounts({ amount: 99999999.99 }).amount).toBe(
      99999999.99,
    );
    expect(() => calculateInvoiceAmounts({ amount: 99999999.995 })).toThrow(
      InvoiceAmountError,
    );
    expect(() =>
      calculateInvoiceAmounts({
        lineItems: [{ price: 99999999, quantity: 2 }],
      }),
    ).toThrow(InvoiceAmountError);
    expect(() =>
      calculateInvoiceAmounts({
        lineItems: [{ price: Number.MAX_VALUE, quantity: 2 }],
      }),
    ).toThrow(InvoiceAmountError);
  });

  test("rejects invalid quantity/rates even when the corresponding tax is hidden", () => {
    expect(() =>
      calculateInvoiceAmounts({ lineItems: [{ quantity: -1, price: 10 }] }),
    ).toThrow(InvoiceAmountError);
    expect(() =>
      calculateInvoiceAmounts({
        template: { taxRate: 101, includeTax: false },
      }),
    ).toThrow(InvoiceAmountError);
    expect(() =>
      calculateInvoiceAmounts({ lineItems: [{ taxRate: -1 }] }),
    ).toThrow(InvoiceAmountError);
  });

  test("historical read snapshots ignore contradictory line items/rates and are never backfilled", () => {
    expect(
      getInvoiceSnapshotAmounts({
        amount: 111,
        vat: 4,
        tax: 7,
        discount: 2,
        lineItems: [{ price: 999, quantity: 99, taxRate: 100 }],
        template: { includeLineItemTax: true, vatRate: 90 },
      }),
    ).toEqual({ total: 111, subTotal: 102, vat: 4, tax: 7 });
    expect(getInvoiceSnapshotAmounts({ amount: 0.3, tax: 0.1 }).subTotal).toBe(
      0.2,
    );
    expect(
      getInvoiceSnapshotAmounts({
        amount: 111,
        subtotal: 90,
        tax: 7,
        vat: 4,
        discount: 2,
      }).subTotal,
    ).toBe(90);
  });
});

describe("financial no-op comparison for finalized/payment-locked invoices", () => {
  const previous = {
    amount: 112,
    subtotal: 100,
    tax: 12,
    vat: null,
    discount: null,
    template: {
      currency: "USD",
      includeVat: false,
      includeLineItemTax: true,
      taxRate: 0,
    },
    lineItems: [{ price: 100, quantity: 1, taxRate: 10 }],
  };

  test("does not recalculate historical totals for omitted or semantically identical fields", () => {
    expect(hasInvoiceFinancialChanges(previous, {})).toBe(false);
    expect(
      hasInvoiceFinancialChanges(previous, {
        ...previous,
        template: { ...previous.template, currency: "usd" },
      }),
    ).toBe(false);
    expect(
      hasInvoiceFinancialChanges(previous, { tax: 12, vat: 0, discount: 0 }),
    ).toBe(false);
  });

  test("ignores derived itemized totals from full editor autosaves", () => {
    expect(
      hasInvoiceFinancialChanges(previous, {
        ...previous,
        amount: 110,
        subtotal: 90,
        vat: 1,
        tax: 10,
      }),
    ).toBe(false);
    expect(hasInvoiceFinancialChanges(previous, { amount: 110 })).toBe(false);
  });

  test("manual amount-only edits still include their supplied monetary fields", () => {
    const manual = { ...previous, lineItems: [] };
    for (const changed of [
      { amount: 110 },
      { subtotal: 99 },
      { vat: 1 },
      { tax: 10 },
      { discount: 1 },
    ]) {
      expect(hasInvoiceFinancialChanges(manual, changed)).toBe(true);
    }
  });

  test("detects itemized source currency, rate, flag, quantity, discount and item-removal edits", () => {
    for (const changed of [
      { discount: 1 },
      { template: { currency: "EUR" } },
      { template: { includeVat: true } },
      { template: { includeLineItemTax: false } },
      { template: { taxRate: 5 } },
      { lineItems: [{ price: 100, quantity: 2, taxRate: 10 }] },
      { lineItems: [{ price: 100, quantity: 1, taxRate: 0 }] },
      { lineItems: [] },
    ])
      expect(hasInvoiceFinancialChanges(previous, changed)).toBe(true);
  });
});
