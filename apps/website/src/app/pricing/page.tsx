import Link from "next/link";
import { InformationPage } from "@/components/information-page";
import { createPageMetadata } from "@/lib/metadata";
import { workspaceUrl } from "@/lib/site";
export const metadata = createPageMetadata({
  title: "Plans for this installation",
  description:
    "Workspace access and billing are managed by the operator of this AGSaaS installation.",
  path: "/pricing",
});
export default function Page() {
  return (
    <InformationPage
      title="Plans for this installation"
      intro="Workspace access and billing are managed by the operator of this AGSaaS installation."
    >
      <section className="border border-border p-6 space-y-4">
        <h2 className="text-xl">Existing workspace</h2>
        <p>
          Sign in to see your team's current access and the billing options
          actually enabled for this installation.
        </p>
        <a
          href={workspaceUrl("/settings/billing")}
          className="inline-block bg-foreground text-background px-5 py-3"
        >
          Open workspace billing
        </a>
      </section>
      <p>
        Public subscription prices and trial offers have not been published for
        this installation. No purchase is offered on this page.
      </p>
      <p>
        <Link href="/support" className="underline">
          Ask about access
        </Link>
      </p>
    </InformationPage>
  );
}
