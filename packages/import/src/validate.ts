import { z } from "zod";
import { isValidTransactionAmount } from "./amount-precision";

export const createTransactionSchema = z.object({
  name: z.string(),
  counterparty_name: z.string().nullable().optional(),
  currency: z.string(),
  bank_account_id: z.string(),
  team_id: z.string(),
  internal_id: z.string(),
  status: z.enum(["posted", "pending"]),
  method: z.enum(["card", "bank", "other"]),
  date: z.string().date(),
  amount: z
    .number()
    .finite()
    .refine((value) => isValidTransactionAmount(value), {
      message:
        "Amount must fit numeric(10,2) without rounding (up to 99999999.99 and two decimal places)",
    }),
  manual: z.boolean(),
  category_slug: z.string().nullable(),
});

export const validateTransactions = (transactions: unknown[]) => {
  const processedTransactions = transactions.map((transaction) =>
    createTransactionSchema.safeParse(transaction),
  );

  const validTransactions = processedTransactions.filter(
    (transaction) => transaction.success,
  );

  const invalidTransactions = processedTransactions.filter(
    (transaction) => !transaction.success,
  );

  return {
    validTransactions: validTransactions.map((transaction) => transaction.data),
    invalidTransactions: invalidTransactions.map(
      (transaction) => transaction.error,
    ),
  };
};
