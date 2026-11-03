import type { Invoice } from "../../types";
import { isInlineLogo } from "../../utils/logo";
import { EditorContent } from "./components/editor-content";
import { Header } from "./components/header";
import { Logo } from "./components/logo";
import { Meta } from "./components/meta";

type Props = {
  data: Invoice;
  logoDataUrl?: string | null;
};

export function OgTemplate({ data, logoDataUrl }: Props) {
  const logo = isInlineLogo(logoDataUrl) ? logoDataUrl : null;
  const {
    customerName,
    status,
    template,
    invoiceNumber,
    issueDate,
    dueDate,
    fromDetails,
    customerDetails,
  } = data;

  return (
    <div
      tw="h-full w-full flex flex-col bg-[#0C0C0C] p-16 py-8"
      style={{ fontFamily: "Liberation Sans" }}
    >
      <Header
        customerName={customerName || ""}
        status={status}
        logoUrl={logo}
        isValidLogo={Boolean(logo)}
      />

      <div tw="flex flex-col">
        <Logo src={logo} customerName={customerName || ""} />
      </div>

      <Meta
        template={template}
        invoiceNumber={invoiceNumber}
        issueDate={issueDate}
        dueDate={dueDate}
      />

      <div tw="flex justify-between mt-10">
        <div tw="flex flex-col flex-1 max-w-[50%]">
          <span
            tw="text-[#858585] text-[22px] mb-1"
            style={{ fontFamily: "Liberation Sans" }}
          >
            {template.fromLabel}
          </span>
          <EditorContent content={fromDetails} />
        </div>

        <div tw="w-12" />

        <div tw="flex flex-col flex-1 max-w-[50%]">
          <span
            tw="text-[#858585] text-[22px] mb-1"
            style={{ fontFamily: "Liberation Sans" }}
          >
            {template.customerLabel}
          </span>
          <EditorContent content={customerDetails} />
        </div>
      </div>
    </div>
  );
}
