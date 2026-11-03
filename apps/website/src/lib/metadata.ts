import type { Metadata } from "next";
import { site } from "@/lib/site";

type PageMetadataOptions = {
  title: string;
  description: string;
  path: string;
  og?: { title: string; description: string };
  keywords?: string[];
  type?: "website" | "article";
  canonical?: boolean;
};
export function createPageMetadata(opts: PageMetadataOptions): Metadata {
  const title = opts.title.replace(/\s*[|—-]\s*(?:Midday|AGSaaS)\s*$/i, "");
  const url = `${site.websiteUrl}${opts.path}`;
  return {
    title,
    description: opts.description,
    keywords: opts.keywords,
    robots: { index: site.indexable, follow: site.indexable },
    openGraph: {
      title: `${title} | AGSaaS`,
      description: opts.description,
      type: opts.type ?? "website",
      url,
    },
    twitter: {
      card: "summary",
      title: `${title} | AGSaaS`,
      description: opts.description,
    },
    ...(opts.canonical === false ? {} : { alternates: { canonical: url } }),
  };
}
