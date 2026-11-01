type Decimal = { coefficient: bigint; scale: number };

export type InvoiceMoneyLineItem = {
  price?: number | null;
  quantity?: number | null;
  taxRate?: number | null;
  vat?: number | null;
  tax?: number | null;
};

export type InvoiceMoneyTemplate = {
  taxRate?: number | null;
  vatRate?: number | null;
  includeVat?: boolean;
  includeTax?: boolean;
  includeLineItemTax?: boolean;
  includeDiscount?: boolean;
  currency?: string | null;
};

/**
 * Stable legacy calculator defaults for sparse persisted/API templates. New UI
 * drafts explicitly opt out of tax/VAT via DEFAULT_TEMPLATE_SETTINGS; an older
 * invoice must not inherit today's mutable team template during hydration.
 */
export function getInvoiceMoneyTemplate(
  template?: InvoiceMoneyTemplate | null,
) {
  return {
    ...template,
    includeTax: template?.includeTax ?? true,
    includeVat: template?.includeVat ?? true,
    includeLineItemTax: template?.includeLineItemTax ?? false,
    includeDiscount: template?.includeDiscount ?? false,
    taxRate: template?.taxRate ?? 0,
    vatRate: template?.vatRate ?? 0,
  };
}

export type InvoiceMoneyInput = {
  lineItems?: InvoiceMoneyLineItem[] | null;
  template?: InvoiceMoneyTemplate | null;
  amount?: number | null;
  subtotal?: number | null;
  vat?: number | null;
  tax?: number | null;
  discount?: number | null;
};

export class InvoiceAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceAmountError";
  }
}

export class InvoiceFinancialStateError extends Error {
  constructor(
    message = "Invoice financial details cannot change after payment has started or the invoice is finalized",
  ) {
    super(message);
    this.name = "InvoiceFinancialStateError";
  }
}

// invoices.amount/subtotal/vat/tax/discount are PostgreSQL numeric(10, 2). This is the
// storage contract, not a currency-specific minor-unit or tax-law policy.
const MAX_INVOICE_CENTS = 9_999_999_999n;
const ZERO: Decimal = { coefficient: 0n, scale: 0 };

function decimal(value: number, field = "Invoice value"): Decimal {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvoiceAmountError(`${field} must be a finite number`);
  }
  // Number.toString gives the caller's decimal value, including exponent
  // notation. Arithmetic below does not introduce binary floating-point drift.
  const [mantissa = "0", exponent = "0"] = value.toString().split(/e/i);
  const fractionLength = mantissa.split(".")[1]?.length ?? 0;
  const scale = fractionLength - Number(exponent);
  const coefficient = BigInt(mantissa.replace(".", ""));
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return {
    coefficient:
      a.coefficient * 10n ** BigInt(scale - a.scale) +
      b.coefficient * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

function multiply(a: Decimal, b: Decimal): Decimal {
  return {
    coefficient: a.coefficient * b.coefficient,
    scale: a.scale + b.scale,
  };
}

function percent(value: Decimal, rate: number): Decimal {
  const product = multiply(value, decimal(rate));
  return { ...product, scale: product.scale + 2 };
}

// Round half away from zero, matching PostgreSQL numeric rather than Math.round
// (which rounds negative halves towards positive infinity).
function cents(value: Decimal): bigint {
  if (value.scale <= 2)
    return value.coefficient * 10n ** BigInt(2 - value.scale);
  const divisor = 10n ** BigInt(value.scale - 2);
  const absolute =
    value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const rounded =
    absolute / divisor + ((absolute % divisor) * 2n >= divisor ? 1n : 0n);
  return value.coefficient < 0n ? -rounded : rounded;
}

function fromCents(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new InvoiceAmountError(
      "Invoice value exceeds safe monetary precision",
    );
  }
  return Number(value) / 100;
}

function storedMoney(value: number, field: string): number {
  const rounded = cents(decimal(value, field));
  if (rounded > MAX_INVOICE_CENTS || rounded < -MAX_INVOICE_CENTS) {
    throw new InvoiceAmountError(
      `${field} exceeds the invoice storage limit of 99999999.99`,
    );
  }
  return fromCents(rounded);
}

/**
 * Shared editor/server calculation. Sum exact decimal line extensions, then
 * round subtotal, VAT and tax once each to two places. Total is the sum of those
 * rounded components minus the rounded discount, so the summary always adds up.
 * Per-line tax takes precedence over invoice-level tax, as in the editor.
 */
export function calculateTotal({
  lineItems,
  taxRate = 0,
  vatRate = 0,
  discount = 0,
  includeVat = true,
  includeTax = true,
  includeLineItemTax = false,
}: {
  lineItems: InvoiceMoneyLineItem[];
  taxRate?: number | null;
  vatRate?: number | null;
  discount?: number | null;
  includeVat?: boolean;
  includeTax?: boolean;
  includeLineItemTax?: boolean;
}) {
  let subtotal = ZERO;
  let lineTax = ZERO;
  for (const item of lineItems || []) {
    if (!item) continue;
    const extension = multiply(
      decimal(item.price ?? 0),
      decimal(item.quantity ?? 0),
    );
    subtotal = add(subtotal, extension);
    if (includeLineItemTax)
      lineTax = add(lineTax, percent(extension, item.taxRate ?? 0));
  }
  const subtotalCents = cents(subtotal);
  const vatCents = includeVat ? cents(percent(subtotal, vatRate ?? 0)) : 0n;
  const taxCents = includeLineItemTax
    ? cents(lineTax)
    : includeTax
      ? cents(percent(subtotal, taxRate ?? 0))
      : 0n;
  const discountCents = cents(decimal(discount ?? 0));
  return {
    subTotal: fromCents(subtotalCents),
    total: fromCents(subtotalCents + vatCents + taxCents - discountCents),
    vat: fromCents(vatCents),
    tax: fromCents(taxCents),
  };
}

export function calculateLineItemTotal({
  price = 0,
  quantity = 0,
}: InvoiceMoneyLineItem) {
  return fromCents(
    cents(multiply(decimal(price ?? 0), decimal(quantity ?? 0))),
  );
}

/** Validate even client totals that will be replaced by the canonical result. */
export function validateInvoiceMoney(input: InvoiceMoneyInput): void {
  for (const field of [
    "amount",
    "subtotal",
    "vat",
    "tax",
    "discount",
  ] as const) {
    if (input[field] != null) storedMoney(input[field], field);
  }
  const validateRate = (value: number | null | undefined, field: string) => {
    if (value == null) return;
    decimal(value, field);
    if (value < 0 || value > 100)
      throw new InvoiceAmountError(`${field} must be between 0 and 100`);
  };
  validateRate(input.template?.taxRate, "taxRate");
  validateRate(input.template?.vatRate, "vatRate");
  for (const [index, item] of (input.lineItems ?? []).entries()) {
    if (!item) continue; // Incomplete editor rows are not billable yet.
    if (item.price != null) decimal(item.price, `lineItems[${index}].price`);
    if (item.quantity != null) {
      decimal(item.quantity, `lineItems[${index}].quantity`);
      if (item.quantity < 0)
        throw new InvoiceAmountError("Line item quantity cannot be negative");
    }
    validateRate(item.taxRate, `lineItems[${index}].taxRate`);
    for (const field of ["vat", "tax"] as const) {
      if (item[field] != null)
        storedMoney(item[field], `lineItems[${index}].${field}`);
    }
  }
}

/** Canonical persistence boundary; amount-only API drafts remain supported. */
export function calculateInvoiceAmounts(input: InvoiceMoneyInput) {
  validateInvoiceMoney(input);
  const discount =
    input.discount == null
      ? input.discount
      : storedMoney(input.discount, "discount");
  if (!input.lineItems?.length) {
    return {
      amount:
        input.amount == null
          ? input.amount
          : storedMoney(input.amount, "amount"),
      // For amount-only invoices the total is authoritative. Keep an explicitly
      // supplied subtotal only while the draft has no total yet.
      subtotal:
        input.amount == null
          ? input.subtotal == null
            ? input.subtotal
            : storedMoney(input.subtotal, "subtotal")
          : storedMoney(
              getInvoiceSnapshotAmounts({ ...input, subtotal: null }).subTotal,
              "subtotal",
            ),
      vat: input.vat == null ? input.vat : storedMoney(input.vat, "vat"),
      tax: input.tax == null ? input.tax : storedMoney(input.tax, "tax"),
      discount,
    };
  }
  const result = calculateTotal({
    ...input.template,
    lineItems: input.lineItems,
    discount,
  });
  return {
    amount: storedMoney(result.total, "amount"),
    subtotal: storedMoney(result.subTotal, "subtotal"),
    vat: storedMoney(result.vat, "vat"),
    tax: storedMoney(result.tax, "tax"),
    discount,
  };
}

/**
 * Readers must use the persisted financial snapshot, including historical
 * invoices. Prefer the persisted subtotal too; for legacy rows without one,
 * derive it from stored components, never today's line-item calculation rules.
 * This deliberately preserves even inconsistent historical snapshots rather
 * than silently repairing legacy records on read.
 */
export function getInvoiceSnapshotAmounts<
  T extends Pick<
    InvoiceMoneyInput,
    "amount" | "subtotal" | "vat" | "tax" | "discount"
  >,
>(input: T) {
  const amount = cents(decimal(input.amount ?? 0));
  const vat = cents(decimal(input.vat ?? 0));
  const tax = cents(decimal(input.tax ?? 0));
  const discount = cents(decimal(input.discount ?? 0));
  return {
    subTotal:
      input.subtotal == null
        ? fromCents(amount - vat - tax + discount)
        : fromCents(cents(decimal(input.subtotal))),
    total: fromCents(amount),
    vat: fromCents(vat),
    tax: fromCents(tax),
  };
}

/**
 * Compare financial source intent without repricing a historical document.
 * Itemized totals are derived, untrusted client fields: a full editor autosave
 * can contain today's calculated totals even though only a note/date changed.
 * Amount-only invoices retain explicit edits to their manual monetary fields.
 */
export function hasInvoiceFinancialChanges(
  previous: InvoiceMoneyInput,
  next: InvoiceMoneyInput,
): boolean {
  const itemized = Boolean(
    previous.lineItems?.length || next.lineItems?.length,
  );
  for (const field of [
    "amount",
    "subtotal",
    "vat",
    "tax",
    "discount",
  ] as const) {
    if (itemized && field !== "discount") continue;
    if (
      next[field] !== undefined &&
      cents(decimal(next[field] ?? 0)) !== cents(decimal(previous[field] ?? 0))
    )
      return true;
  }
  const previousTemplate = getInvoiceMoneyTemplate(previous.template);
  const nextTemplate = next.template ?? {};
  if (
    nextTemplate.currency !== undefined &&
    (nextTemplate.currency ?? "").toUpperCase() !==
      (previousTemplate.currency ?? "").toUpperCase()
  )
    return true;
  for (const field of ["taxRate", "vatRate"] as const) {
    if (
      nextTemplate[field] !== undefined &&
      (nextTemplate[field] ?? 0) !== (previousTemplate[field] ?? 0)
    )
      return true;
  }
  for (const field of [
    "includeTax",
    "includeVat",
    "includeLineItemTax",
  ] as const) {
    const defaultValue = field !== "includeLineItemTax";
    if (
      nextTemplate[field] !== undefined &&
      (nextTemplate[field] ?? defaultValue) !==
        (previousTemplate[field] ?? defaultValue)
    )
      return true;
  }
  if (next.lineItems !== undefined) {
    const previousItems = previous.lineItems ?? [];
    const nextItems = next.lineItems ?? [];
    if (nextItems.length !== previousItems.length) return true;
    if (
      nextItems.some((item, index) =>
        ["price", "quantity", "taxRate"].some((field) => {
          const key = field as "price" | "quantity" | "taxRate";
          return (item?.[key] ?? 0) !== (previousItems[index]?.[key] ?? 0);
        }),
      )
    )
      return true;
  }
  return false;
}
