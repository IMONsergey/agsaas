import { InformationPage } from "@/components/information-page";
import { site } from "@/lib/site";
export const metadata = { title: "Source and notices" };
export default function Page() {
  const source = site.revision
    ? `${site.sourceRepository}/tree/${site.revision}`
    : site.sourceRepository;
  const archive = site.revision
    ? `${site.sourceRepository}/archive/${site.revision}.tar.gz`
    : null;
  return (
    <InformationPage
      title="Source and notices"
      intro="Source for this independently operated AGSaaS installation."
    >
      <p>
        AGSaaS is derived from Midday. The repository retains the original
        copyright notices and license materials.
      </p>
      <p>
        <a href={source} className="underline">
          Browse the source repository
        </a>
      </p>
      {archive ? (
        <>
          <p>
            Build revision: <code className="break-all">{site.revision}</code>
          </p>
          <p>
            <a href={archive} className="underline">
              Download source for this build
            </a>
          </p>
        </>
      ) : (
        <p>
          This development build does not yet identify a release revision. It
          must not be used as a verified release source offer.
        </p>
      )}
      <p>
        <a
          href={`${source.replace("/tree/", "/blob/")}${site.revision ? "" : "/blob/main"}/LICENSE`}
          className="underline"
        >
          Read the license
        </a>
      </p>
      <p>
        Dependency licenses and deployment instructions are included in the
        repository.{" "}
      </p>
    </InformationPage>
  );
}
