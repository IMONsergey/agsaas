type ServerFetchOptions = {
  internalUrl?: string;
  fetch?: typeof globalThis.fetch;
};

function parseBaseUrl(value: string, setting: string): URL {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid base URL");
    }
    return url;
  } catch {
    // Configuration failures must not log credentials or raw URL values.
    throw new Error(
      `${setting} must be an absolute HTTP(S) URL without credentials, query, or fragment`,
    );
  }
}

/**
 * Server-side HTTP transport only. Always give the SDK its canonical public
 * URL: it defines SSR cookie names, Auth identity, and returned Storage URLs.
 * This wrapper routes matching network requests over the private network
 * without changing those client settings or rewriting response payloads.
 */
export function createSupabaseFetch(
  canonicalUrl: string,
  options: ServerFetchOptions = {},
): typeof globalThis.fetch {
  const fetcher = options.fetch ?? globalThis.fetch;
  const internalUrl = options.internalUrl ?? process.env.SUPABASE_INTERNAL_URL;
  if (!internalUrl?.trim()) return fetcher;

  const canonical = parseBaseUrl(canonicalUrl, "Supabase canonical URL");
  const internal = parseBaseUrl(internalUrl, "SUPABASE_INTERNAL_URL");
  const canonicalPath = canonical.pathname.replace(/\/+$/, "");
  const internalPath = internal.pathname.replace(/\/+$/, "");

  function rewriteUrl(input: string | URL): URL | null {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      // Preserve native/custom-fetch behavior for relative or invalid inputs.
      return null;
    }
    if (
      url.origin !== canonical.origin ||
      url.username ||
      url.password ||
      (url.pathname !== canonicalPath &&
        !url.pathname.startsWith(`${canonicalPath}/`))
    ) {
      return null;
    }

    const destination = new URL(internal);
    destination.pathname =
      `${internalPath}${url.pathname.slice(canonicalPath.length)}` || "/";
    destination.search = url.search;
    destination.hash = url.hash;
    return destination;
  }

  const routedFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const destination = rewriteUrl(
      input instanceof Request ? input.url : input,
    );
    if (!destination) return fetcher(input, init);

    let routedInput: Parameters<typeof globalThis.fetch>[0];
    if (input instanceof Request) {
      // Build from Request fields instead of cloning a Request with a stream
      // body: that clone can leave ReadableStream bodies pending in Bun.
      // Apply caller overrides before construction, including body overrides
      // when the original body has already been consumed.
      const duplex: "half" = "half";
      const requestOptions = {
        method: input.method,
        headers: input.headers,
        body: input.body,
        cache: input.cache,
        credentials: input.credentials,
        integrity: input.integrity,
        keepalive: input.keepalive,
        mode: input.mode,
        redirect: input.redirect,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        signal: input.signal,
        duplex,
        ...init,
      };
      routedInput = new Request(destination.toString(), requestOptions);
    } else {
      routedInput = input instanceof URL ? destination : destination.toString();
    }

    // Forward init too: native Request overrides and runtime-specific fetch
    // options must remain intact, including caller-provided abort signals.
    return fetcher(routedInput, init);
  };

  // Bun adds preconnect to typeof fetch; other runtimes do not. Keep that
  // optional capability without requiring it at runtime or using type casts.
  return Object.assign(routedFetch, {
    preconnect: (
      url: Parameters<typeof globalThis.fetch.preconnect>[0],
      options?: Parameters<typeof globalThis.fetch.preconnect>[1],
    ) => fetcher.preconnect?.(rewriteUrl(url) ?? url, options),
  });
}
