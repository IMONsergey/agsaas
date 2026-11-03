/**
 * Auth cookies follow the canonical public URL, never the optional private
 * server transport. An explicit installation name also scopes PKCE/chunk keys.
 * Missing configuration preserves the deployed SDK name until a planned rollout.
 * Path, HttpOnly and SameSite keep their existing SSR defaults.
 */
export function getAuthCookieOptions(
  canonicalUrl: string | undefined,
  installationName = process.env.NEXT_PUBLIC_AUTH_COOKIE_NAME,
): {
  secure: boolean;
  name?: string;
} {
  if (installationName && !/^[a-z][a-z0-9_-]{7,79}$/.test(installationName)) {
    throw new Error(
      "NEXT_PUBLIC_AUTH_COOKIE_NAME must be a stable installation name of 8-80 lowercase letters, digits, underscores or hyphens",
    );
  }
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
    return {
      secure: url.protocol === "https:",
      ...(installationName ? { name: installationName } : {}),
    };
  } catch {
    // Configuration failures must not expose raw URLs or credentials.
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment",
    );
  }
}
