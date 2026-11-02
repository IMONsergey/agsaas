type AvatarEnvironment = {
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
};

const publicAvatarPrefix = "/storage/v1/object/public/avatars/";

/** Public avatar objects on this installation, never an arbitrary remote URL. */
export function isOwnPublicAvatarUrl(
  value: string,
  env: AvatarEnvironment = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  },
): boolean {
  try {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject raw controls before URL parsing can normalize a storage object identifier.
    if (!value || value.length > 4096 || /[\\\u0000-\u0020\u007f]/.test(value))
      return false;
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;

    const origins = [env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL].flatMap(
      (raw) => {
        if (!raw) return [];
        try {
          const configured = new URL(raw);
          return ["https:", "http:"].includes(configured.protocol) &&
            !configured.username &&
            !configured.password &&
            !configured.search &&
            !configured.hash &&
            configured.pathname === "/"
            ? [configured.origin]
            : [];
        } catch {
          return [];
        }
      },
    );
    if (!origins.includes(url.origin)) return false;

    // Inspect the original path before WHATWG URL removes dot segments.
    const rawPath = value.match(/^https?:\/\/[^/?#]+(\/[^?#]*)/i)?.[1];
    if (
      !rawPath ||
      rawPath !== url.pathname ||
      !rawPath.startsWith(publicAvatarPrefix)
    )
      return false;
    const objectPath = rawPath.slice(publicAvatarPrefix.length);
    if (!objectPath || objectPath.length > 2048) return false;
    return objectPath.split("/").every((segment) => {
      const decoded = decodeURIComponent(segment);
      return (
        !!decoded &&
        decoded !== "." &&
        decoded !== ".." &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Decoded avatar segments must reject controls before reaching Storage.
        !/[%/\\?#\u0000-\u001f\u007f]/.test(decoded)
      );
    });
  } catch {
    return false;
  }
}
