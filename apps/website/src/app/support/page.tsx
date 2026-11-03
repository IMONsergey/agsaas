import Link from "next/link";
import { InformationPage } from "@/components/information-page";
import { SupportForm } from "@/components/support-form";
import { workspaceUrl } from "@/lib/site";
export const dynamic = "force-dynamic";
export const metadata = { title: "Support" };
export default function Page() {
  if (process.env.AGSAAS_SUPPORT_INGEST_KEY?.trim()) return <SupportForm />;
  return (
    <InformationPage
      title="Help with your workspace"
      intro="Start with the product guide or contact the administrator who provided your access."
    >
      <p>
        Online ticket delivery is not configured for this installation. No
        message is sent by this page.
      </p>
      <div className="flex flex-wrap gap-4">
        <Link href="/docs" className="border border-border px-4 py-3">
          Open the guide
        </Link>
        <a
          href={workspaceUrl("/account/support")}
          className="border border-border px-4 py-3"
        >
          Workspace support
        </a>
      </div>
      <p>
        Include the screen, time, expected result and operation ID. Keep
        passwords, access tokens and unrelated financial records out of support
        requests.
      </p>
    </InformationPage>
  );
}
