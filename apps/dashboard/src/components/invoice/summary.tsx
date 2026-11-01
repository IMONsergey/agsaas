import type { InvoiceMoneyInput } from "@midday/invoice/calculate";
import { useEffect } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useTemplateUpdate } from "@/hooks/use-template-update";
import { useInvoiceEditorStore } from "@/store/invoice-editor";
import { AnimatedNumber } from "../animated-number";
import { FormatAmount } from "../format-amount";
import { AmountInput } from "./amount-input";
import { LabelInput } from "./label-input";
import { TaxInput } from "./tax-input";
import { getInvoiceEditorSummary } from "./utils/summary-values";
import { VATInput } from "./vat-input";

export function Summary() {
  const {
    control,
    setValue,
    getValues,
    formState: { defaultValues },
  } = useFormContext();
  const { updateTemplate } = useTemplateUpdate();
  const acknowledged = useInvoiceEditorStore(
    (state) => state.financialSnapshot,
  );

  const includeDecimals = useWatch({
    control,
    name: "template.includeDecimals",
  });

  const maximumFractionDigits = includeDecimals ? 2 : 0;

  const currency = useWatch({
    control,
    name: "template.currency",
  });

  const locale = useWatch({
    control,
    name: "template.locale",
  });

  const includeTax = useWatch({
    control,
    name: "template.includeTax",
  });

  const taxRate = useWatch({
    control,
    name: "template.taxRate",
  });

  const vatRate = useWatch({
    control,
    name: "template.vatRate",
  });

  const includeVat = useWatch({
    control,
    name: "template.includeVat",
  });

  const includeDiscount = useWatch({
    control,
    name: "template.includeDiscount",
  });

  const includeLineItemTax = useWatch({
    control,
    name: "template.includeLineItemTax",
  });

  const lineItems = useWatch({
    control,
    name: "lineItems",
  });

  const discount = useWatch({
    control,
    name: "discount",
  });

  const loaded = defaultValues as
    | (InvoiceMoneyInput & {
        status?: string;
        id: string;
        template?: InvoiceMoneyInput["template"] & {
          includeDiscount?: boolean;
        };
      })
    | undefined;
  const initial = acknowledged?.id === getValues("id") ? acknowledged : loaded;
  const summary = getInvoiceEditorSummary(initial, {
    ...getValues(),
    lineItems,
    discount,
    template: {
      currency,
      taxRate,
      vatRate,
      includeVat,
      includeTax,
      includeLineItemTax,
    },
  });
  const { subTotal, total, vat: totalVAT, tax: totalTax } = summary.display;
  const {
    amount: formAmount,
    subtotal: formSubtotal,
    vat: formVat,
    tax: formTax,
    discount: formDiscount,
  } = summary.values;

  useEffect(() => {
    const values = {
      amount: formAmount,
      subtotal: formSubtotal,
      vat: formVat,
      tax: formTax,
      discount: formDiscount,
    };
    for (const [field, value] of Object.entries(values)) {
      if (getValues(field) !== value)
        setValue(field, value, { shouldValidate: true });
    }
  }, [
    formAmount,
    formSubtotal,
    formVat,
    formTax,
    formDiscount,
    getValues,
    setValue,
  ]);

  useEffect(() => {
    if (!includeTax && !summary.preserveSnapshot) {
      setValue("template.taxRate", 0, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }, [includeTax, summary.preserveSnapshot, setValue]);

  useEffect(() => {
    if (!includeVat && !summary.preserveSnapshot) {
      setValue("template.vatRate", 0, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }, [includeVat, summary.preserveSnapshot, setValue]);

  useEffect(() => {
    if (
      !includeDiscount &&
      (!summary.preserveSnapshot ||
        initial?.template?.includeDiscount !== includeDiscount)
    ) {
      setValue("discount", 0, { shouldValidate: true, shouldDirty: true });
    }
  }, [
    includeDiscount,
    summary.preserveSnapshot,
    initial?.template?.includeDiscount,
    setValue,
  ]);

  return (
    <div className="w-[320px] flex flex-col">
      <div className="flex justify-between items-center py-1">
        <LabelInput
          className="flex-shrink-0 min-w-6"
          name="template.subtotalLabel"
          onSave={(value) => {
            updateTemplate({ subtotalLabel: value });
          }}
        />
        <span className="text-right text-[11px] text-[#878787]">
          <FormatAmount
            amount={subTotal}
            maximumFractionDigits={maximumFractionDigits}
            currency={currency}
            locale={locale}
          />
        </span>
      </div>

      {includeDiscount && (
        <div className="flex justify-between items-center py-1">
          <LabelInput
            name="template.discountLabel"
            onSave={(value) => {
              updateTemplate({ discountLabel: value });
            }}
          />

          <AmountInput
            placeholder="0"
            allowNegative={false}
            name="discount"
            className="text-right text-[11px] text-[#878787] border-none"
          />
        </div>
      )}

      {includeVat && (
        <div className="flex justify-between items-center py-1">
          <div className="flex items-center gap-1">
            <LabelInput
              className="flex-shrink-0 min-w-5"
              name="template.vatLabel"
              onSave={(value) => {
                updateTemplate({ vatLabel: value });
              }}
            />

            <VATInput />
          </div>

          <span className="text-right text-[11px] text-[#878787]">
            <FormatAmount
              amount={totalVAT}
              maximumFractionDigits={2}
              currency={currency}
              locale={locale}
            />
          </span>
        </div>
      )}

      {includeTax && !includeLineItemTax && (
        <div className="flex justify-between items-center py-1">
          <div className="flex items-center gap-1">
            <LabelInput
              className="flex-shrink-0 min-w-5"
              name="template.taxLabel"
              onSave={(value) => {
                updateTemplate({ taxLabel: value });
              }}
            />

            <TaxInput />
          </div>

          <span className="text-right text-[11px] text-[#878787]">
            <FormatAmount
              amount={totalTax}
              maximumFractionDigits={2}
              currency={currency}
              locale={locale}
            />
          </span>
        </div>
      )}

      {includeLineItemTax && totalTax > 0 && (
        <div className="flex justify-between items-center py-1">
          <LabelInput
            className="flex-shrink-0 min-w-5"
            name="template.taxLabel"
            onSave={(value) => {
              updateTemplate({ taxLabel: value });
            }}
          />

          <span className="text-right text-[11px] text-[#878787]">
            <FormatAmount
              amount={totalTax}
              maximumFractionDigits={2}
              currency={currency}
              locale={locale}
            />
          </span>
        </div>
      )}

      <div className="flex justify-between items-center py-4 mt-2 border-t border-border">
        <LabelInput
          name="template.totalSummaryLabel"
          onSave={(value) => {
            updateTemplate({ totalSummaryLabel: value });
          }}
        />
        <span className="text-right font-medium text-[21px]">
          <AnimatedNumber
            value={total}
            currency={currency}
            maximumFractionDigits={
              includeTax || includeVat || includeLineItemTax
                ? 2
                : maximumFractionDigits
            }
          />
        </span>
      </div>
    </div>
  );
}
