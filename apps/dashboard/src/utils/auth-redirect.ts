import { sanitizeRedirectPath } from "@midday/utils/sanitize-redirect";

function hasUnsafeCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || character === "\\";
  });
}

/** Accept relative paths or same-origin URLs; never trust a client origin. */
export function getAuthRedirectUrl(raw: string, canonicalUrl: string): string {
  let origin: string;
  try {
    const canonical = new URL(canonicalUrl);
    if (
      !["http:", "https:"].includes(canonical.protocol) ||
      canonical.username ||
      canonical.password ||
      canonical.search ||
      canonical.hash ||
      canonical.pathname !== "/"
    ) {
      throw new Error("Invalid origin");
    }
    origin = canonical.origin;
  } catch {
    throw new Error("The application sign-in URL is not configured correctly");
  }

  const fallback = `${origin}/`;
  let candidate = raw.trim();
  if (hasUnsafeCharacters(raw) || candidate.startsWith("//")) {
    return fallback;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    try {
      const absolute = new URL(candidate);
      if (
        absolute.origin !== origin ||
        absolute.username ||
        absolute.password
      ) {
        return fallback;
      }
      candidate = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    } catch {
      return fallback;
    }
  } else if (!candidate.startsWith("/")) {
    candidate = `/${candidate}`;
  }

  // Reuse the same path boundary as the OAuth callback, including decoding.
  const safePath = sanitizeRedirectPath(candidate);
  if (hasUnsafeCharacters(safePath)) return fallback;
  const destination = new URL(safePath, origin);
  return destination.origin === origin ? destination.toString() : fallback;
}
