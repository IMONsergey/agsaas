import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Inbox",
  description:
    "Upload receipts directly and review them alongside your transactions.",
  path: "/inbox",
});
export default function Page() {
  return <ProductPage page="inbox" />;
}
