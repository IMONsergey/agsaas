import Link from "next/link";
import { InformationPage } from "@/components/information-page";

import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "The project",
  description:
    "AGSaaS is an independently operated workspace derived from Midday.",
  path: "/story",
});
export default function Page() {
  return (
    <InformationPage
      title="The project"
      intro="AGSaaS is an independently operated workspace derived from Midday."
    >
      <p>
        The project is being developed around its own data, deployment and
        operating procedures. Original source attribution remains available.
      </p>
      <Link href="/source" className="underline">
        Source and notices
      </Link>
    </InformationPage>
  );
}
