import type { MetadataRoute } from "next";
import { getAllDocSlugs } from "@/lib/docs";
import { site } from "@/lib/site";
export const baseUrl = site.websiteUrl;
export default function sitemap(): MetadataRoute.Sitemap {
  if (!site.indexable) return [];
  return [
    ...[
      "",
      "/about",
      "/pricing",
      "/download",
      "/bank-coverage",
      "/integrations",
      "/compare",
      "/story",
      "/updates",
      "/agents",
      "/computer",
      "/sdks",
      "/chat",
      "/source",
      "/status",
      "/terms",
      "/policy",
      "/support",
      "/docs",
      "/mcp",
      "/invoicing",
      "/transactions",
      "/customers",
      "/time-tracking",
      "/file-storage",
      "/inbox",
      "/pre-accounting",
      "/insights",
      "/assistant",
    ],
    ...getAllDocSlugs().map((slug) => `/docs/${slug}`),
  ].map((path) => ({ url: `${site.websiteUrl}${path}` }));
}
