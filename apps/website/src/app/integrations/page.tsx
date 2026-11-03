import { InformationPage } from "@/components/information-page";
import { createPageMetadata } from "@/lib/metadata";
import { workspaceUrl } from "@/lib/site";
export const metadata = createPageMetadata({
  title: "Connections with a clear purpose",
  description:
    "Choose integrations in the Apps section of your workspace, where configuration and connection status are shown.",
  path: "/integrations",
});
export default function Page() {
  return (
    <InformationPage
      title="Connections with a clear purpose"
      intro="Choose integrations in the Apps section of your workspace, where configuration and connection status are shown."
    >
      <ul className="list-disc pl-5 space-y-3">
        <li>
          Gmail and Outlook Inbox integrations import receipts for review.
        </li>
        <li>
          Stripe Payments enables customer invoice payments when your own
          payment account is connected.
        </li>
        <li>
          Accounting integrations transfer selected records to the connected
          accounting service.
        </li>
        <li>
          AI tools are a separate type of connection and require a configured AI
          connector service.
        </li>
      </ul>
      <a
        href={workspaceUrl("/apps")}
        className="inline-block bg-foreground text-background px-5 py-3"
      >
        Open Apps
      </a>
      <p>
        Each service requires its own credentials and authorization. An
        integration name does not imply that it is enabled on this installation.
      </p>
    </InformationPage>
  );
}
