import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Exports",
  description:
    "Organize transactions, invoices and supporting files before handing records to your accountant.",
  path: "/pre-accounting",
});
export default function Page() {
  return <ProductPage page="pre-accounting" />;
}
