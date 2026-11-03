import { InformationPage } from "@/components/information-page";
import { createPageMetadata } from "@/lib/metadata";
import { workspaceUrl } from "@/lib/site";
export const metadata = createPageMetadata({
  title: "Use AGSaaS in your browser",
  description: "The supported application is the web workspace.",
  path: "/download",
});
export default function Page() {
  return (
    <InformationPage
      title="Use AGSaaS in your browser"
      intro="The supported application is the web workspace."
    >
      <a
        href={workspaceUrl("/login")}
        className="inline-block bg-foreground text-background px-5 py-3"
      >
        Open web workspace
      </a>
      <section className="border border-border p-6 space-y-3">
        <h2 className="text-xl">Desktop applications</h2>
        <p>
          A signed AGSaaS desktop release has not been published for Apple
          Silicon or Intel. Downloads are unavailable for both architectures.
        </p>
        <p>
          Existing Midday desktop releases connect to a different service and
          are not distributed as AGSaaS.
        </p>
      </section>
    </InformationPage>
  );
}
