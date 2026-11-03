import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Time tracking",
  description:
    "Use project timers or enter time manually, then review work before including it in an invoice.",
  path: "/time-tracking",
});
export default function Page() {
  return <ProductPage page="time-tracking" />;
}
