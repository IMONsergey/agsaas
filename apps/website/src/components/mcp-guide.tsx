import Link from "next/link";
import { InformationPage } from "@/components/information-page";
import { site, workspaceUrl } from "@/lib/site";
export function McpGuide({
  client = "a compatible client",
}: {
  client?: string;
}) {
  return (
    <InformationPage
      title={`Connect ${client}`}
      intro="Use the remote MCP server belonging to this AGSaaS installation."
    >
      <p>Server URL:</p>
      <pre className="border border-border bg-secondary/30 p-4 overflow-x-auto">
        {site.apiUrl}/mcp
      </pre>
      <ol className="list-decimal pl-5 space-y-3">
        <li>
          Check that your client supports remote MCP and the authorization flow
          provided by this server.
        </li>
        <li>Add the server URL above in the client's connection settings.</li>
        <li>
          Complete authorization in your own AGSaaS workspace, selecting the
          correct account, team and permissions.
        </li>
        <li>
          Start with a read-only request and verify the returned records before
          enabling write operations.
        </li>
      </ol>
      <p>
        Client features and account requirements can differ. If the client
        cannot complete authorization, use the web workspace or a supported
        client. Do not paste access tokens into a chat conversation.
      </p>
      <p>
        <a href={workspaceUrl("/settings/developer")} className="underline">
          Manage access in Developer settings
        </a>
      </p>
      <p>
        <Link href="/docs/developer" className="underline">
          API and MCP guide
        </Link>
      </p>
    </InformationPage>
  );
}
