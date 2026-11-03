import { InformationPage } from "@/components/information-page";
import { createPageMetadata } from "@/lib/metadata";
import { workspaceUrl } from "@/lib/site";
export const metadata = createPageMetadata({
  title: "Bank connections",
  description:
    "Bank availability depends on the provider configured for your installation.",
  path: "/bank-coverage",
});
export default function Page() {
  return (
    <InformationPage
      title="Bank connections"
      intro="Bank availability depends on the provider configured for your installation."
    >
      <p>
        Open Bank Connections in your workspace to see the provider and
        institutions available to your team. If no provider is configured,
        automatic sync is unavailable.
      </p>
      <a
        href={workspaceUrl("/settings/accounts")}
        className="inline-block border border-border px-5 py-3"
      >
        Check workspace connections
      </a>
      <section className="border border-border p-6 space-y-3">
        <h2 className="text-xl">Start with a statement</h2>
        <p>
          You can import a CSV file or add transactions manually without
          connecting a bank.
        </p>
        <a
          href={workspaceUrl("/transactions?step=import&hide=true")}
          className="underline"
        >
          Import CSV
        </a>
      </section>
      <p>
        This page does not publish a sample bank catalogue as live coverage.
      </p>
    </InformationPage>
  );
}
