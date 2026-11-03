import type { getTransactionsByIds } from "@midday/db/queries";
import { ensureFileExtension } from "@midday/utils";
import {
  calculateBaseTaxAmount,
  getTaxTypeLabel,
  resolveTaxValues,
} from "@midday/utils/tax";
import { format, parseISO } from "date-fns";
import { safeArchiveName, type AssetRequest } from "../../utils/export-archive";

export function formatTransactionExport(
  transactionsData: Awaited<ReturnType<typeof getTransactionsByIds>>,
  locale: string,
  dateFormat?: string | null,
) {
  const attachments: AssetRequest[] = transactionsData.flatMap((transaction) =>
    (transaction.attachments ?? []).map((attachment) => {
      const filename = attachment.type
        ? ensureFileExtension(attachment.name || "attachment", attachment.type)
        : attachment.name || "attachment";
      return {
        id: attachment.id,
        transactionId: transaction.id,
        path: attachment.path,
        size: attachment.size,
        contentType: attachment.type,
        name: `attachments/${transaction.amount < 0 ? "expense" : "income"}/${transaction.id}_${attachment.id}_${safeArchiveName(filename)}`,
      };
    }),
  );
  const rows = [...transactionsData]
    .sort((a, b) => parseISO(a.date).getTime() - parseISO(b.date).getTime())
    .map((transaction) => {
      const { taxAmount, taxRate, taxType } = resolveTaxValues({
        transactionAmount: transaction.amount,
        transactionTaxAmount: transaction.tax_amount,
        transactionTaxRate: transaction.tax_rate,
        transactionTaxType: transaction.tax_type,
        categoryTaxRate: transaction.category?.tax_rate,
        categoryTaxType: transaction.category?.tax_type,
      });

      const formattedTaxType = getTaxTypeLabel(taxType ?? "");
      const formattedTaxRate = taxRate != null ? `${taxRate}%` : "";

      const hasBaseCurrency =
        transaction.base_amount != null &&
        transaction.base_currency &&
        transaction.base_currency !== transaction.currency;

      const baseTaxAmount = calculateBaseTaxAmount({
        amount: transaction.amount,
        taxAmount,
        taxRate,
        baseAmount: transaction.base_amount,
        baseCurrency: transaction.base_currency,
        currency: transaction.currency,
      });

      return [
        transaction.id,
        format(parseISO(transaction.date), dateFormat ?? "LLL dd, y"),
        transaction.name,
        transaction.description,
        transaction.amount,
        transaction.currency,
        Intl.NumberFormat(locale, {
          style: "currency",
          currency: transaction.currency,
        }).format(transaction.amount),
        hasBaseCurrency ? transaction.base_amount : "",
        hasBaseCurrency ? transaction.base_currency : "",
        formattedTaxType,
        formattedTaxRate,
        Intl.NumberFormat(locale, {
          style: "currency",
          currency: transaction.currency,
        }).format(taxAmount ?? 0),
        baseTaxAmount != null
          ? Intl.NumberFormat(locale, {
              style: "currency",
              currency: transaction.base_currency!,
            }).format(baseTaxAmount)
          : "",
        transaction?.counterparty_name ?? "",
        transaction?.category?.name ?? "",
        transaction?.category?.description ?? "",
        transaction?.category?.tax_reporting_code ?? "",
        transaction?.attachments?.length > 0 ||
        transaction?.status === "completed"
          ? "Completed"
          : "Not completed",
        attachments
          .filter((a) => a.transactionId === transaction.id)
          .map((a) => a.name)
          .join(", ") ?? "",
        transaction?.balance ?? "",
        transaction?.bank_account?.name ?? "",
        transaction?.note ?? "",
        transaction?.tags?.map((t) => t.tag?.name).join(", ") ?? "",
      ];
    });

  return { rows: rows ?? [], assets: attachments };
}
