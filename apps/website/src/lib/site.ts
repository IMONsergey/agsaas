import { installationOrigin } from "@midday/utils/envs";

const env = { NODE_ENV: process.env.NODE_ENV };
export const site = {
  name: "AGSaaS",
  description:
    "Customers, invoices, transactions, documents and tracked time in one workspace.",
  websiteUrl: installationOrigin(
    "NEXT_PUBLIC_WEBSITE_URL",
    process.env.NEXT_PUBLIC_WEBSITE_URL,
    "http://localhost:3000",
    env,
  ),
  dashboardUrl: installationOrigin(
    "NEXT_PUBLIC_DASHBOARD_URL",
    process.env.NEXT_PUBLIC_DASHBOARD_URL || process.env.NEXT_PUBLIC_URL,
    "http://localhost:3001",
    env,
  ),
  apiUrl: installationOrigin(
    "NEXT_PUBLIC_API_URL",
    process.env.NEXT_PUBLIC_API_URL,
    "http://localhost:3003",
    env,
  ),
  indexable: process.env.NEXT_PUBLIC_SITE_INDEXABLE === "true",
  sourceRepository: "https://github.com/IMONsergey/agsaas",
  revision: /^[a-f0-9]{40}$/.test(process.env.NEXT_PUBLIC_RELEASE_SHA ?? "")
    ? process.env.NEXT_PUBLIC_RELEASE_SHA
    : null,
};

export function workspaceUrl(path = "/") {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Workspace links must use a local path");
  return `${site.dashboardUrl}${path}`;
}
