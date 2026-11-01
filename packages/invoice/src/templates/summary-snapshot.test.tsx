import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { Summary as HtmlSummary } from "./html/components/summary";
import { Summary as PdfSummary } from "./pdf/components/summary";

function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement<{ children?: unknown }>(node))
    return textOf(node.props.children);
  return "";
}

describe("HTML/PDF persisted financial snapshot parity", () => {
  const props = {
    amount: 111,
    vat: 4,
    tax: 7,
    discount: 2,
    includeVat: true,
    includeTax: true,
    includeLineItemTax: true,
    includeDiscount: true,
    includeDecimals: true,
    currency: "USD",
    locale: "en-US",
    taxRate: 99,
    vatRate: 90,
    discountLabel: "Discount",
    vatLabel: "VAT",
    taxLabel: "Tax",
    subtotalLabel: "Subtotal",
    totalLabel: "Total",
    lineItems: [{ price: 1000, quantity: 1, taxRate: 20 }],
  };

  for (const [name, Summary] of [
    ["HTML", HtmlSummary],
    ["PDF", PdfSummary],
  ] as const) {
    test(`${name} preserves an explicit historical subtotal instead of silently repairing it`, () => {
      const text = textOf(Summary({ ...props, subtotal: 90 }));
      expect(text).toContain("90.00");
      expect(text).toContain("111.00");
      expect(text).not.toContain("102.00");
    });

    test(`${name} renders stored total, VAT and line-tax instead of recomputing a historical invoice`, () => {
      const text = textOf(Summary(props));
      for (const amount of ["111.00", "102.00", "7.00", "4.00"])
        expect(text).toContain(amount);
      expect(text).not.toContain("1,000");
      expect(text).not.toContain("200.00");
    });

    test(`${name} renders amount-only invoices without inventing line items`, () => {
      const text = textOf(
        Summary({
          ...props,
          amount: 200,
          tax: 0,
          vat: 0,
          discount: 0,
          lineItems: [],
        }),
      );
      expect(text).toContain("200.00");
    });
  }
});
