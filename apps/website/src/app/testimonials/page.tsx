import Link from "next/link";
import { InformationPage } from "@/components/information-page";

import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Customer stories",
  description: "Verified AGSaaS customer stories have not been published.",
  path: "/testimonials",
});
export default function Page() {
  return (
    <InformationPage
      title="Customer stories"
      intro="Verified AGSaaS customer stories have not been published."
    >
      <p>
        Testimonials for other products are not presented as evidence for this
        installation.
      </p>
      <Link href="/docs" className="underline">
        Explore the actual workflows
      </Link>
    </InformationPage>
  );
}
