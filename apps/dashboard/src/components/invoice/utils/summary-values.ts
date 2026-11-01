import {
  calculateTotal,
  getInvoiceMoneyTemplate,
  getInvoiceSnapshotAmounts,
  hasInvoiceFinancialChanges,
  type InvoiceMoneyInput,
} from "@midday/invoice/calculate";

export type InvoiceEditorSnapshot = InvoiceMoneyInput & {
  id: string;
  status?: string;
  currency?: string | null;
};

/** Financial values of an existing invoice never inherit a current team template. */
export function getInvoiceEditorTemplate(
  defaults?: Record<string, unknown> | null,
  loaded?: {
    template?: InvoiceMoneyInput["template"];
    currency?: string | null;
  },
) {
  return {
    ...defaults,
    ...loaded?.template,
    ...(loaded ? getInvoiceMoneyTemplate(loaded.template) : {}),
    currency:
      loaded?.currency ??
      loaded?.template?.currency ??
      (typeof defaults?.currency === "string" ? defaults.currency : undefined),
  };
}

/** Copy only immutable financial primitives; form objects are mutable references. */
export function captureInvoiceFinancialSnapshot(
  input: InvoiceEditorSnapshot,
): InvoiceEditorSnapshot {
  const template = getInvoiceMoneyTemplate(input.template);
  return {
    id: input.id,
    status: input.status,
    amount: input.amount,
    subtotal: input.subtotal,
    vat: input.vat,
    tax: input.tax,
    discount: input.discount,
    template: {
      currency: input.currency ?? input.template?.currency,
      includeTax: template.includeTax,
      includeVat: template.includeVat,
      includeLineItemTax: template.includeLineItemTax,
      includeDiscount: template.includeDiscount,
      taxRate: template.taxRate,
      vatRate: template.vatRate,
    },
    lineItems: input.lineItems?.map((item) => ({
      price: item?.price,
      quantity: item?.quantity,
      taxRate: item?.taxRate,
    })),
  };
}

/**
 * The editor store supplies the loaded or last acknowledged snapshot. Keep an
 * issued invoice's original summary until its financial sources actually
 * change, not merely when the editor mounts or a note/date is autosaved.
 */
export function getInvoiceEditorSummary(
  initial: InvoiceEditorSnapshot | undefined,
  current: InvoiceMoneyInput,
) {
  const preserveSnapshot = Boolean(
    initial?.status &&
      initial.status !== "draft" &&
      !hasInvoiceFinancialChanges(initial, current),
  );
  if (preserveSnapshot && initial) {
    return {
      preserveSnapshot,
      display: getInvoiceSnapshotAmounts(initial),
      // Preserve nullable/missing fields exactly as loaded. In particular, do
      // not manufacture a new stored subtotal for a historical null subtotal.
      values: {
        amount: initial.amount,
        subtotal: initial.subtotal,
        vat: initial.vat,
        tax: initial.tax,
        discount: initial.discount,
      },
    };
  }

  const display = current.lineItems?.length
    ? calculateTotal({
        ...current.template,
        lineItems: current.lineItems,
        discount: current.discount,
      })
    : getInvoiceSnapshotAmounts({
        ...current,
        subtotal: current.amount == null ? current.subtotal : null,
      });
  return {
    preserveSnapshot,
    display,
    values: {
      amount: display.total,
      subtotal: display.subTotal,
      vat: display.vat,
      tax: display.tax,
      discount: current.discount ?? 0,
    },
  };
}
