import Link from "next/link";
import { InformationPage } from "@/components/information-page";

import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "About AGSaaS",
  description:
    "AGSaaS brings day-to-day business records into an independently operated workspace.",
  path: "/about",
});
export default function Page() {
  return (
    <InformationPage
      title="About AGSaaS"
      intro="AGSaaS brings day-to-day business records into an independently operated workspace."
    >
      <p>
        Manage customers, invoices, transactions, receipts, documents and
        tracked time. Core work can start with manual entry and CSV import.
      </p>
      <p>
        This installation is based on the open-source Midday codebase. AGSaaS
        has its own deployment, configuration and release process. Optional
        third-party services are connected by the installation administrator.
      </p>
      <p>
        <Link href="/source" className="underline">
          View source and attribution
        </Link>
      </p>
    </InformationPage>
  );
}
