import {
  formatAmountValue,
  formatDate,
  type ImportParseProfile,
} from "@midday/import";

import { mappableFields } from "./context";

/**
 * Returns the balance from the latest dated row in the preview sample only.
 * This is not an authoritative statement/account balance and is never sent as
 * currentBalance by the import form.
 */
export function getBalanceFromLatestDate(
  rows: Record<string, string>[],
  dateColumn: string,
  balanceColumn: string,
  parseProfile?: ImportParseProfile,
): string | undefined {
  if (
    !rows.length ||
    !dateColumn ||
    !balanceColumn ||
    balanceColumn === "None"
  ) {
    return undefined;
  }

  const rowsWithDates = rows
    .map((row) => ({
      row,
      parsed: formatDate(row[dateColumn] ?? "", parseProfile?.dateOrder),
    }))
    .filter((r): r is { row: Record<string, string>; parsed: string } =>
      Boolean(r.parsed),
    );

  if (rowsWithDates.length === 0) return undefined;

  const latest = rowsWithDates.sort((a, b) =>
    b.parsed.localeCompare(a.parsed),
  )[0];

  return latest?.row[balanceColumn]?.trim() || undefined;
}

export function isActiveRequest(
  requestId: number,
  activeRequestRef: { current: number },
) {
  return requestId === activeRequestRef.current;
}

/** A statement balance is signed and is never inverted like a credit amount. */
export function parseBalancePreview(
  value: string,
  profile?: ImportParseProfile,
) {
  return formatAmountValue({
    amount: value,
    amountFormat: profile?.amountFormat,
  });
}

export function shouldApplyMappedColumn(
  field: string,
  value: unknown,
  fileColumns: string[],
): field is keyof typeof mappableFields {
  return (
    Object.keys(mappableFields).includes(field) &&
    typeof value === "string" &&
    fileColumns.includes(value)
  );
}
