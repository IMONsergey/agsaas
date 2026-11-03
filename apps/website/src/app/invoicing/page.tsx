import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Invoices",
  description:
    "Create invoices from customer records, products and tracked time. Keep draft, issued and paid states visible in your workspace.",
  path: "/invoicing",
});
export default function Page() {
  return <ProductPage page="invoicing" />;
}
