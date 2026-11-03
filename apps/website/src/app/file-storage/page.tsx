import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Documents",
  description:
    "Upload and organize supporting documents without sending them to another product's storage.",
  path: "/file-storage",
});
export default function Page() {
  return <ProductPage page="file-storage" />;
}
