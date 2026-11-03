import { getCurrencyMultiplier } from "@midday/invoice/currency";
import { InvoicePaymentError } from "./errors";

function exactInvoiceAmount(
  amount: number | null,
  currency: string | null,
  maximumMinor: bigint,
) {
  if (
    !currency ||
    !/^[a-z]{3}$/i.test(currency) ||
    amount === null ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 99_999_999.99
  ) {
    throw new InvoicePaymentError(
      400,
      "Invalid invoice payment amount or currency",
    );
  }

  // Storage is numeric(10,2). Reject fractional minor units instead of silently
  // rounding e.g. JPY 100.25 down to a different charge amount.
  const fixed = amount.toFixed(2);
  if (Number(fixed) !== amount) {
    throw new InvoicePaymentError(
      400,
      "Invoice amount exceeds storage precision",
    );
  }
  const [whole, fraction] = fixed.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction!);
  const normalized = currency.toLowerCase();
  // Stripe's charge API retains two-decimal wire units for ISK and UGX even
  // though neither currency permits fractional charges. Keep the whole-unit
  // validation separate from the shared Stripe wire/display conversion.
  const legacyTwoDecimalWire = normalized === "isk" || normalized === "ugx";
  if (legacyTwoDecimalWire && cents % 100n !== 0n) {
    throw new InvoicePaymentError(
      400,
      "This currency requires a whole-unit charge",
    );
  }
  const scaled = cents * BigInt(getCurrencyMultiplier(currency));
  if (scaled % 100n !== 0n || scaled / 100n > maximumMinor) {
    throw new InvoicePaymentError(
      400,
      "Invoice amount is not supported for this currency",
    );
  }
  return { amountMinor: Number(scaled / 100n), currency: normalized };
}

export function getInvoicePaymentAmount(
  amount: number | null,
  currency: string | null,
) {
  return exactInvoiceAmount(amount, currency, 99_999_999n);
}

/** Same exact currency representation as provider amounts; zero is valid for reading an invoice. */
export function getInvoiceLedgerAmount(
  amount: number | null,
  currency: string | null,
) {
  if (amount === 0 && currency && /^[a-z]{3}$/i.test(currency))
    return { amountMinor: 0, currency: currency.toLowerCase() };
  return exactInvoiceAmount(amount, currency, 9_007_199_254_740_991n);
}
