import type { ImportCsvFormData } from "./context";

/** Explicitly copy the form contract; preview rows are never account balances. */
export function buildImportRequest(
  data: ImportCsvFormData,
  filePath?: string[],
) {
  return {
    filePath,
    currency: data.currency,
    bankAccountId: data.bank_account_id,
    inverted: data.inverted,
    parseProfile: data.parseProfile,
    mappings: {
      amount: data.amount,
      date: data.date,
      description: data.description,
      counterparty: data.counterparty,
      balance: data.balance,
    },
  };
}
