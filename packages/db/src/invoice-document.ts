/** Printable invoice fields only. Provider identifiers and internal notes never enter a document snapshot. */
export const invoiceDocumentFields = [
  "invoiceNumber",
  "issueDate",
  "dueDate",
  "amount",
  "currency",
  "lineItems",
  "paymentDetails",
  "customerDetails",
  "fromDetails",
  "noteDetails",
  "customerName",
  "customerId",
  "discount",
  "subtotal",
  "vat",
  "tax",
  "topBlock",
  "bottomBlock",
  "template",
] as const;

export type InvoiceDocumentSnapshot = {
  version: 1;
  source: "issued" | "generation" | "legacy_current";
  capturedAt: string;
  document: Partial<Record<(typeof invoiceDocumentFields)[number], unknown>>;
};

export function captureInvoiceDocument(
  row: Record<string, unknown>,
  source: InvoiceDocumentSnapshot["source"],
): InvoiceDocumentSnapshot {
  return {
    version: 1,
    source,
    capturedAt: new Date().toISOString(),
    document: Object.fromEntries(
      invoiceDocumentFields.map((field) => [field, row[field] ?? null]),
    ),
  };
}

export function applyInvoiceDocument<
  T extends { documentSnapshot: InvoiceDocumentSnapshot | null },
>(row: T): T {
  if (!row.documentSnapshot || row.documentSnapshot.version !== 1) return row;
  const snapshot = row.documentSnapshot.document;
  return {
    ...row,
    ...Object.fromEntries(
      invoiceDocumentFields
        .filter((field) => field in snapshot)
        .map((field) => [field, snapshot[field]]),
    ),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Dates/notes retain the working-row edit contract; the issued snapshot stays unchanged. */
export function hasInvoiceIdentityChanges(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  for (const field of [
    "invoiceNumber",
    "customerId",
    "customerName",
    "customerDetails",
    "fromDetails",
  ] as const) {
    if (
      next[field] !== undefined &&
      canonical(previous[field]) !== canonical(next[field])
    )
      return true;
  }
  if (next.lineItems !== undefined) {
    const identity = (value: unknown) =>
      Array.isArray(value)
        ? value.map((item) => ({
            name: item?.name ?? null,
            unit: item?.unit ?? null,
            productId: item?.productId ?? null,
          }))
        : [];
    return (
      canonical(identity(previous.lineItems)) !==
      canonical(identity(next.lineItems))
    );
  }
  return false;
}
