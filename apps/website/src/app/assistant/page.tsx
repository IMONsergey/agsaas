import { ProductPage } from "@/components/product-page";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Assistant",
  description:
    "Use configured AI tools to work with your workspace while retaining access to every manual workflow.",
  path: "/assistant",
});
export default function Page() {
  return <ProductPage page="assistant" />;
}
