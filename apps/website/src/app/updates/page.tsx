import Link from "next/link";
import { InformationPage } from "@/components/information-page";

import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Release information",
  description:
    "The running installation determines which features and integrations are available.",
  path: "/updates",
});
export default function Page() {
  return (
    <InformationPage
      title="Release information"
      intro="The running installation determines which features and integrations are available."
    >
      <p>
        Use the source page to identify the build and the corresponding source.
        Integration readiness is available in the workspace's Apps and Billing
        screens.
      </p>
      <Link href="/source" className="underline">
        Inspect this build
      </Link>
    </InformationPage>
  );
}
