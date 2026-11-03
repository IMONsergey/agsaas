import Link from "next/link";
import { notFound } from "next/navigation";
import { DocsMDX } from "@/components/docs/mdx";
import { InformationPage } from "@/components/information-page";
import { getAllDocSlugs, getDocBySlug } from "@/lib/docs";
import { createPageMetadata } from "@/lib/metadata";

type Props = { params: Promise<{ slug: string }> };
export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}
export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) return {};
  return createPageMetadata({
    title: doc.metadata.title,
    description: doc.metadata.description,
    path: `/docs/${doc.slug}`,
  });
}
export default async function Page({ params }: Props) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) notFound();
  return (
    <InformationPage
      title={doc.metadata.title}
      intro={doc.metadata.description}
    >
      <Link href="/docs" className="underline">
        All guides
      </Link>
      <DocsMDX source={doc.content} />
    </InformationPage>
  );
}
