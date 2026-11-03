import { InformationPage } from "@/components/information-page";
import { site } from "@/lib/site";
import { checkSiteStatus } from "@/lib/site-status";
export const dynamic = "force-dynamic";
export const metadata = { title: "Service status" };
export default async function Page() {
  const status = await checkSiteStatus(site.apiUrl, site.dashboardUrl);
  return (
    <InformationPage
      title="Service availability"
      intro="Point-in-time checks for this AGSaaS installation."
    >
      <p className="text-muted-foreground">Checked at {status.checkedAt}</p>
      <dl className="divide-y divide-border border border-border">
        {status.probes.map((probe) => (
          <div
            key={probe.name}
            className="p-5 flex flex-wrap justify-between gap-3"
          >
            <dt>{probe.name}</dt>
            <dd className="capitalize">{probe.state}</dd>
          </div>
        ))}
      </dl>
      <p>
        These checks cover API dependencies and the sign-in page. They do not
        confirm every user workflow, email delivery, bank sync or payment
        provider.
      </p>
      <a href="/status" className="underline">
        Run the checks again
      </a>
    </InformationPage>
  );
}
