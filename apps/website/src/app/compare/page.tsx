import Link from "next/link";
import { InformationPage } from "@/components/information-page";

import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata({
  title: "Evaluate the workspace",
  description: "Use the same real workflow when comparing business tools.",
  path: "/compare",
});
export default function Page() {
  return (
    <InformationPage
      title="Evaluate the workspace"
      intro="Use the same real workflow when comparing business tools."
    >
      <ol className="list-decimal pl-5 space-y-3">
        <li>Create a customer and an invoice in the required currency.</li>
        <li>Import a small statement and verify every amount and date.</li>
        <li>Attach a receipt and export the selected records.</li>
        <li>
          Check roles, file access, recovery and your local document
          requirements.
        </li>
        <li>
          Review the services and costs needed for bank sync, email and
          payments.
        </li>
      </ol>
      <p>
        AGSaaS does not publish unverified competitor claims or customer
        endorsements.
      </p>
      <Link href="/docs" className="underline">
        Read the product guide
      </Link>
    </InformationPage>
  );
}
