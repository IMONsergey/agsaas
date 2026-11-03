import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Transactions",
  description:
    "Enter transactions manually, import bank statements from CSV and organize records by category, tag and account.",
  path: "/transactions",
});
export default function Page() {
  return <ProductPage page="transactions" />;
}
