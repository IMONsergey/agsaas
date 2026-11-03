import type {
  BankSyncClaim,
  BankSyncTransaction,
} from "@midday/db/queries/bank-sync";
import { z } from "zod";

// Current bank storage has two decimal places. Reject unsupported precision
// instead of reporting success after silently rounding provider money.
const money = z
  .number()
  .finite()
  .min(-99999999.99)
  .max(99999999.99)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001,
  );
const transactionSchema = z.object({
  id: z.string().min(1).max(512),
  amount: money,
  currency: z.string().regex(/^[A-Z]{3}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["posted", "pending"]),
  balance: money.nullable(),
  category: z.string().max(200).nullable(),
  counterparty_name: z.string().max(1000).nullable(),
  merchant_name: z.string().max(1000).nullable(),
  method: z.string().max(100),
  name: z.string().min(1).max(1000),
  description: z.string().max(10000).nullable(),
});
export const balanceSchema = z.object({
  amount: money,
  currency: z.string().regex(/^[A-Z]{3}$/),
  available_balance: money.nullable(),
  credit_limit: money.nullable(),
});
type Claim = Extract<BankSyncClaim, { state: "claimed" }>;

export function bankProviderConfigured(
  provider: Claim["connection"]["provider"],
  env: Record<string, string | undefined> = process.env,
) {
  const groups = {
    plaid: ["PLAID_CLIENT_ID", "PLAID_SECRET"],
    teller: ["TELLER_CERT_BASE64", "TELLER_KEY_BASE64"],
    gocardless: ["GOCARDLESS_SECRET_ID", "GOCARDLESS_SECRET_KEY"],
    enablebanking: [
      "ENABLEBANKING_APPLICATION_ID",
      "ENABLE_BANKING_KEY_CONTENT",
      "ENABLEBANKING_REDIRECT_URL",
    ],
  } as const;
  return groups[provider].every((key) => Boolean(env[key]?.trim()));
}

export function validateBankTransactions(
  value: unknown,
): BankSyncTransaction[] {
  const parsed = z.array(transactionSchema).max(10000).parse(value);
  if (
    Buffer.byteLength(JSON.stringify(parsed)) > 16 * 1024 * 1024 ||
    new Set(parsed.map((item) => item.id)).size !== parsed.length
  )
    throw new Error("Invalid provider batch");
  return parsed;
}
