/**
 * Auth cookies follow the canonical public URL, never the optional private
 * server transport. Keep the SSR defaults for name, path and SameSite.
 */
export function getAuthCookieOptions(canonicalUrl: string | undefined): {
  secure: boolean;
} {
  try {
    const url = new URL(canonicalUrl ?? "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid canonical URL");
    }
    return { secure: url.protocol === "https:" };
  } catch {
    // Configuration failures must not expose raw URLs or credentials.
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment",
    );
  }
}
