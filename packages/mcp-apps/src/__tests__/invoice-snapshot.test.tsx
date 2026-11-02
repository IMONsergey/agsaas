import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceTemplate } from "../invoice";

test("MCP invoice preview renders persisted financial snapshot without repricing legacy lines", () => {
  const markup = renderToStaticMarkup(
    <InvoiceTemplate
      data={{
        amount: 111,
        vat: 4,
        tax: 7,
        discount: 2,
        currency: "USD",
        issueDate: "2026-01-01",
        dueDate: "2026-02-01",
        invoiceNumber: "2026-001",
        lineItems: [{ price: 1000, quantity: 1, taxRate: 20 }],
        template: {
          includeDecimals: true,
          includeVat: true,
          includeLineItemTax: true,
          includeDiscount: true,
        },
      }}
    />,
  );
  for (const amount of ["$111.00", "$102.00", "$7.00", "$4.00"])
    expect(markup).toContain(amount);
  // A line extension may still display $1,000; the summary must not recalculate
  // it into a new $1,200 payment obligation on a historical invoice.
  expect(markup).not.toContain("$1,200.00");
});
