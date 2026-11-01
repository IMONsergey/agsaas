const FILE_ENDPOINTS = new Set([
  "/files/proxy",
  "/files/download/file",
  "/files/download/invoice",
]);

/** Add a file capability only to this installation's exact API origin. */
export function authenticatedFileUrl(
  source: string,
  apiBase: string | undefined,
  fileKey: string | null | undefined,
): string | null {
  if (!apiBase || !fileKey) return null;
  try {
    const base = new URL(apiBase);
    const url = new URL(source, base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      !FILE_ENDPOINTS.has(url.pathname)
    )
      return null;
    url.searchParams.set("fk", fileKey);
    return url.toString();
  } catch {
    return null;
  }
}
