import Link from "next/link";
import { InformationPage } from "@/components/information-page";
import { createPageMetadata } from "@/lib/metadata";
import { workspaceUrl } from "@/lib/site";
export const metadata = createPageMetadata({
  title: "Work with the web application",
  description:
    "The browser workspace is the supported interface for this installation.",
  path: "/computer",
});
export default function Page() {
  return (
    <InformationPage
      title="Work with the web application"
      intro="The browser workspace is the supported interface for this installation."
    >
      <p>
        Use direct manual workflows for invoices, transactions, customers,
        documents and time tracking. Optional AI connections are configured
        separately.
      </p>
      <a
        href={workspaceUrl("/login")}
        className="inline-block bg-foreground text-background px-5 py-3"
      >
        Open workspace
      </a>
      <p>
        <Link href="/mcp" className="underline">
          Connect a compatible AI client
        </Link>
      </p>
    </InformationPage>
  );
}
