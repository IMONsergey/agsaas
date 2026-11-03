import { site } from "./site";
export function serverApiOrigin(
  internal = process.env.API_INTERNAL_URL,
  publicOrigin = site.apiUrl,
) {
  if (!internal) return publicOrigin;
  const url = new URL(internal);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid internal API origin");
  if (url.origin !== publicOrigin && url.origin !== "http://api:8080")
    throw new Error("Internal API origin is not an installation service");
  return url.origin;
}
