import { createHash } from "node:crypto";

export const financialJobQueues = {
  "generate-invoice": "invoices",
  "enrich-transactions": "transactions",
  "match-transactions-bidirectional": "inbox",
  notification: "notifications",
} as const;

export type FinancialJobName = keyof typeof financialJobQueues;
export type FinancialJobStatus =
  | "pending"
  | "accepted"
  | "completed"
  | "failed";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function financialRequestHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function financialJobOperationKey(
  jobName: FinancialJobName,
  source: string,
): string {
  if (!(jobName in financialJobQueues) || !source || source.length > 512)
    throw new Error("Invalid financial job identity");
  return financialRequestHash(["financial-job-v1", jobName, source]);
}

export function financialJobId(id: string): string {
  return `financial-${id}`;
}

export class FinancialOperationConflictError extends Error {
  constructor(
    message = "This operation ID was already used with different transaction details",
  ) {
    super(message);
    this.name = "FinancialOperationConflictError";
  }
}
