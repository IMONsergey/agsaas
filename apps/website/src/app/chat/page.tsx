import { InformationPage } from "@/components/information-page";
import { createPageMetadata } from "@/lib/metadata";
import { workspaceUrl } from "@/lib/site";
export const metadata = createPageMetadata({
  title: "Messaging connections",
  description:
    "Receipt capture through chat is optional and must use this installation's configured bot.",
  path: "/chat",
});
export default function Page() {
  return (
    <InformationPage
      title="Messaging connections"
      intro="Receipt capture through chat is optional and must use this installation's configured bot."
    >
      <p>
        Check Apps in your workspace for the available Slack, Telegram, WhatsApp
        and iMessage connections. Pairing and connection status are specific to
        your user and team.
      </p>
      <a
        href={workspaceUrl("/apps")}
        className="inline-block border border-border px-5 py-3"
      >
        Check messaging apps
      </a>
      <p>
        You can upload receipts directly to Inbox without connecting a messaging
        provider.
      </p>
    </InformationPage>
  );
}
