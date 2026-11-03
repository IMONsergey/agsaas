import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Customers",
  description:
    "Keep contact details, invoices, projects and billing information together.",
  path: "/customers",
});
export default function Page() {
  return <ProductPage page="customers" />;
}
