import Link from "next/link";
import { InformationPage } from "@/components/information-page";
import { createPageMetadata } from "@/lib/metadata";
import { site } from "@/lib/site";
export const metadata = createPageMetadata({
  title: "API and client development",
  description:
    "Build integrations against the API deployed with this workspace.",
  path: "/sdks",
});
export default function Page() {
  return (
    <InformationPage
      title="API and client development"
      intro="Build integrations against the API deployed with this workspace."
    >
      <p>
        The API documentation describes the current routes and authentication.
        Use an access token scoped to the intended team and operations.
      </p>
      <a href={`${site.apiUrl}/openapi`} className="underline">
        Open this installation's API
      </a>
      <p>
        Do not assume an upstream SDK defaults to the AGSaaS API. Set the API
        base URL explicitly and verify compatibility with the running release.
      </p>
      <pre className="border border-border p-4 overflow-x-auto">
        {site.apiUrl}
      </pre>
      <p>
        <Link href="/source" className="underline">
          Inspect source and release details
        </Link>
      </p>
    </InformationPage>
  );
}
