/**
 * Import parsing is independent of the browser/server locale. In auto mode only
 * unambiguous values are accepted; the user must choose a profile otherwise.
 * Four-digit years are required, so no moving two-digit-year pivot is involved.
 */
export type ImportDateOrder = "auto" | "day-first" | "month-first";
export type ImportAmountFormat = "auto" | "decimal-comma" | "decimal-dot";

export type ImportParseProfile = {
  dateOrder?: ImportDateOrder;
  amountFormat?: ImportAmountFormat;
};

export type ImportParseResult<T> =
  | { value: T; error?: never }
  | { value?: never; error: "missing" | "invalid" | "ambiguous" };

/** Retain exact source digits so transaction validation never rounds silently. */
export type ImportAmountParseResult = ImportParseResult<number> & {
  normalizedDecimal?: string;
};
