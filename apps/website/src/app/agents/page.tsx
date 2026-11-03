import Link from "next/link";
import { InformationPage } from "@/components/information-page";
import { createPageMetadata } from "@/lib/metadata";
import { workspaceUrl } from "@/lib/site";
export const metadata = createPageMetadata({
  title: "Automation and API access",
  description: "Use the API or MCP endpoint belonging to this installation.",
  path: "/agents",
});
export default function Page() {
  return (
    <InformationPage
      title="Automation and API access"
      intro="Use the API or MCP endpoint belonging to this installation."
    >
      <p>
        Create scoped access in your workspace's Developer settings. Grant only
        the permissions needed for the task, and review access when an
        integration is no longer used.
      </p>
      <a href={workspaceUrl("/settings/developer")} className="underline">
        Open Developer settings
      </a>
      <p>
        <Link href="/mcp" className="underline">
          MCP connection guide
        </Link>
      </p>
      <p>No upstream Midday account is required to access this installation.</p>
    </InformationPage>
  );
}
