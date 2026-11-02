import { createHash } from "node:crypto";
import { capitalCase } from "change-case";
import { isValidTransactionAmount } from "./amount-precision";
import type { ImportParseProfile } from "./parse-profile";
import type { Transaction } from "./types";
import { formatDate, parseAmountValue } from "./utils";

function normalizeFingerprintValue(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildDeterministicInternalId({
  transaction,
  normalizedDescription,
  normalizedCounterparty,
  formattedDate,
  formattedAmount,
}: {
  transaction: Transaction;
  normalizedDescription?: string;
  normalizedCounterparty?: string;
  formattedDate?: string;
  formattedAmount: number;
}) {
  const fingerprint = [
    normalizeFingerprintValue(transaction.bankAccountId),
    normalizeFingerprintValue(formattedDate),
    String(formattedAmount),
    normalizeFingerprintValue(transaction.currency.toUpperCase()),
    normalizeFingerprintValue(normalizedDescription),
    normalizeFingerprintValue(normalizedCounterparty),
  ].join("|");

  const hash = createHash("sha256")
    .update(fingerprint)
    .digest("hex")
    .slice(0, 24);

  return `${transaction.teamId}_${hash}`;
}

export function transform({
  transaction,
  inverted,
  parseProfile,
}: {
  transaction: Transaction;
  inverted: boolean;
  parseProfile?: ImportParseProfile;
}) {
  const normalizedDescription = transaction.description?.trim();
  const normalizedCounterparty = transaction.counterparty?.trim();
  const formattedDate = formatDate(transaction.date, parseProfile?.dateOrder);
  const parsedAmount = parseAmountValue({
    amount: transaction.amount,
    inverted,
    amountFormat: parseProfile?.amountFormat,
  });
  const amount = parsedAmount.value ?? Number.NaN;
  const formattedAmount = isValidTransactionAmount(
    amount,
    parsedAmount.normalizedDecimal,
  )
    ? amount
    : Number.NaN;

  return {
    internal_id: buildDeterministicInternalId({
      transaction,
      normalizedDescription,
      normalizedCounterparty,
      formattedDate,
      formattedAmount,
    }),
    team_id: transaction.teamId,
    status: "posted",
    method: "other",
    date: formattedDate,
    amount: formattedAmount,
    name: capitalCase(
      normalizedDescription || normalizedCounterparty || "Transaction",
    ),
    counterparty_name: normalizedCounterparty
      ? capitalCase(normalizedCounterparty)
      : null,
    manual: true,
    category_slug: formattedAmount > 0 ? "income" : null,
    bank_account_id: transaction.bankAccountId,
    currency: transaction.currency.toUpperCase(),
    notified: true,
  };
}

/**
 * Create ONCE per file, not per parser chunk or database batch. The first
 * occurrence retains the pre-existing internal_id so reimports of legacy rows
 * remain idempotent. Further identical operations get stable occurrence IDs.
 *
 * Without a source bank transaction ID, overlapping exports can only reconcile
 * the maximum observed multiplicity of a fingerprint. This is not a claim of
 * global transaction identity, and no previously imported values are rewritten.
 */
export function createTransactionTransformer(options: {
  inverted: boolean;
  parseProfile?: ImportParseProfile;
}) {
  const occurrences = new Map<string, number>();
  return (transaction: Transaction) => {
    const transformed = transform({ transaction, ...options });
    const occurrence = (occurrences.get(transformed.internal_id) ?? 0) + 1;
    occurrences.set(transformed.internal_id, occurrence);
    return occurrence === 1
      ? transformed
      : {
          ...transformed,
          internal_id: `${transformed.internal_id}_${occurrence}`,
        };
  };
}
