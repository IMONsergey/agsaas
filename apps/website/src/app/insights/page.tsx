import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Reports",
  description:
    "Review revenue, spending and activity from the records held in your workspace.",
  path: "/insights",
});
export default function Page() {
  return <ProductPage page="insights" />;
}
