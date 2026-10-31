/**
 * Existing transactions.amount is PostgreSQL numeric(10, 2). Reject values it
 * cannot store exactly; never change the schema or round an imported operation.
 * Source digits are necessary: Number("1.00000000000000001") is already 1.
 */
export function isValidTransactionAmount(
  value: number,
  sourceDecimal?: string,
) {
  if (!Number.isFinite(value) || Math.abs(value) > 99_999_999.99) return false;
  const decimal = sourceDecimal ?? String(Math.abs(value));
  if (!/^\d+(?:\.\d+)?$/.test(decimal)) return false;
  const fraction = decimal.split(".")[1] ?? "";
  return fraction.replace(/0+$/, "").length <= 2;
}
