import type { Metadata } from "next";

export const metadata: Metadata = { title: "Source and notices | AGSaaS" };
export default function SourcePage() {
  const revision = process.env.NEXT_PUBLIC_RELEASE_SHA;
  const exact = revision && /^[a-f0-9]{40}$/.test(revision);
  const repository = "https://github.com/IMONsergey/agsaas";
  return (
    <main className="max-w-3xl mx-auto p-6 md:p-12 space-y-6">
      <h1 className="text-3xl">AGSaaS source and notices</h1>
      <p>
        AGSaaS is independently operated software derived from Midday. The
        source retains original copyright notices and license materials.
      </p>
      <p>
        <a
          className="underline"
          href={exact ? `${repository}/tree/${revision}` : repository}
        >
          Browse the source
        </a>
      </p>
      {exact ? (
        <>
          <p>
            Build: <code className="break-all">{revision}</code>
          </p>
          <p>
            <a
              className="underline"
              href={`${repository}/archive/${revision}.tar.gz`}
            >
              Download source for this build
            </a>
          </p>
        </>
      ) : (
        <p>
          This development build does not identify a release revision. Contact
          the administrator for the source matching the running build.
        </p>
      )}
      <p>
        <a
          className="underline"
          href={`${repository}/blob/${exact ? revision : "main"}/LICENSE`}
        >
          License
        </a>
      </p>
      <a className="underline" href="/">
        Back to workspace
      </a>
    </main>
  );
}
