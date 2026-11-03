import { z } from "zod";

/**
 * Transaction job schemas (independent from @midday/jobs)
 */

export const exportTransactionsSchema = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  userEmail: z.string().email().optional(),
  locale: z
    .string()
    .min(2)
    .max(35)
    .regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,3}$/),
  dateFormat: z
    .string()
    .refine(
      (value) =>
        ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "dd.MM.yyyy"].includes(
          value,
        ),
      "Unsupported date format",
    )
    .nullable()
    .optional(),
  transactionIds: z.array(z.string().uuid()).min(1).max(10000),
  exportSettings: z
    .object({
      csvDelimiter: z.enum([",", ";", "\t", "|"]),
      includeCSV: z.boolean(),
      includeXLSX: z.boolean(),
      sendEmail: z.boolean(),
      sendCopyToMe: z.boolean().optional(),
      accountantEmail: z.string().optional(),
    })
    .optional(),
});

export type ExportTransactionsPayload = z.infer<
  typeof exportTransactionsSchema
>;

export const exportTeamDataSchema = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  userEmail: z.string().email().optional(),
  locale: z
    .string()
    .min(2)
    .max(35)
    .regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,3}$/)
    .optional(),
  dateFormat: z
    .string()
    .refine(
      (value) =>
        ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "dd.MM.yyyy"].includes(
          value,
        ),
      "Unsupported date format",
    )
    .nullable()
    .optional(),
});

export type ExportTeamDataPayload = z.infer<typeof exportTeamDataSchema>;

export const processExportSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(10000),
  teamId: z.string().uuid(),
  locale: z
    .string()
    .min(2)
    .max(35)
    .regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,3}$/),
  dateFormat: z
    .string()
    .refine(
      (value) =>
        ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "dd.MM.yyyy"].includes(
          value,
        ),
      "Unsupported date format",
    )
    .nullable()
    .optional(),
});

export type ProcessExportPayload = z.infer<typeof processExportSchema>;

export const processTransactionAttachmentSchema = z.object({
  transactionId: z.string().uuid(),
  mimetype: z.string(),
  filePath: z.array(z.string()),
  teamId: z.string().uuid(),
});

export type ProcessTransactionAttachmentPayload = z.infer<
  typeof processTransactionAttachmentSchema
>;

export const enrichTransactionsSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(10000),
  teamId: z.string().uuid(),
});

export type EnrichTransactionsPayload = z.infer<
  typeof enrichTransactionsSchema
>;

export const importTransactionsSchema = z.object({
  inverted: z.boolean(),
  parseProfile: z
    .object({
      dateOrder: z.enum(["auto", "day-first", "month-first"]).optional(),
      amountFormat: z.enum(["auto", "decimal-comma", "decimal-dot"]).optional(),
    })
    .strict()
    .optional(),
  filePath: z.array(z.string().min(1).max(255)).min(2).max(32).optional(),
  bankAccountId: z.string().uuid(),
  currency: z.string(),
  teamId: z.string().uuid(),
  table: z
    .array(
      z
        .record(z.string().max(256), z.string().max(8192))
        .refine((row) => Object.keys(row).length <= 100, "At most 100 columns"),
    )
    .max(10000)
    .optional(),
  mappings: z
    .object({
      amount: z.string(),
      date: z.string(),
      description: z.string().optional(),
      counterparty: z.string().optional(),
      balance: z.string().optional(),
    })
    .refine((mappings) => !!mappings.description || !!mappings.counterparty, {
      message: "Either description or counterparty mapping is required",
      path: ["description"],
    }),
});

export type ImportTransactionsPayload = z.infer<
  typeof importTransactionsSchema
>;

export const updateBaseCurrencySchema = z.object({
  teamId: z.string().uuid(),
  baseCurrency: z.string(),
});

export type UpdateBaseCurrencyPayload = z.infer<
  typeof updateBaseCurrencySchema
>;

export const updateAccountBaseCurrencySchema = z.object({
  accountId: z.string().uuid(),
  currency: z.string(),
  balance: z.number(),
  baseCurrency: z.string(),
});

export type UpdateAccountBaseCurrencyPayload = z.infer<
  typeof updateAccountBaseCurrencySchema
>;
