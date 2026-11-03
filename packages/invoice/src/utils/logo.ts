import { installationOrigin } from "@midday/utils/envs";

export const MAX_PUBLIC_LOGO_BYTES = 5 * 1024 * 1024;
const MAX_LOGO_PIXELS = 16_000_000;
const PUBLIC_AVATARS = "/storage/v1/object/public/avatars/";

type LogoEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NODE_ENV?: string;
};

/** Only explicitly configured, public own Storage objects can be fetched. */
export function getPublicLogoUrl(
  input?: string | null,
  env: LogoEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
  },
): string | null {
  if (!input || !env.NEXT_PUBLIC_SUPABASE_URL) return null;
  try {
    const origin = installationOrigin(
      "NEXT_PUBLIC_SUPABASE_URL",
      env.NEXT_PUBLIC_SUPABASE_URL,
      "http://localhost:54321",
      env,
    );
    const url = new URL(input);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(PUBLIC_AVATARS)
    )
      return null;
    const segments = url.pathname.slice(PUBLIC_AVATARS.length).split("/");
    if (
      !segments.length ||
      segments.some((part) => {
        const decoded = decodeURIComponent(part);
        return (
          !decoded ||
          decoded === "." ||
          decoded === ".." ||
          /[%/\\]/.test(decoded) ||
          [...decoded].some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        );
      })
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function rasterDetails(
  bytes: Uint8Array,
): { mime: string; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (from: number, count: number) =>
    String.fromCharCode(...bytes.subarray(from, from + count));
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
    ascii(12, 4) === "IHDR"
  )
    return {
      mime: "image/png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(0, 6)))
    return {
      mime: "image/gif",
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const uint24 = (offset: number) =>
      bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16);
    const format = ascii(12, 4);
    if (format === "VP8X")
      return {
        mime: "image/webp",
        width: uint24(24) + 1,
        height: uint24(27) + 1,
      };
    if (
      format === "VP8 " &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    )
      return {
        mime: "image/webp",
        width: view.getUint16(26, true) & 16383,
        height: view.getUint16(28, true) & 16383,
      };
    if (format === "VP8L" && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      return {
        mime: "image/webp",
        width: (bits & 16383) + 1,
        height: ((bits >>> 14) & 16383) + 1,
      };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 217 || marker === 218) return null;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      ) {
        if (length < 8) return null;
        return {
          mime: "image/jpeg",
          height: view.getUint16(offset + 3),
          width: view.getUint16(offset + 5),
        };
      }
      offset += length;
    }
  }
  return null;
}

/** A rendering boundary, never an authorization check for an external URL. */
export function isInlineLogo(input?: string | null): input is string {
  return (
    typeof input === "string" &&
    input.length <= Math.ceil(MAX_PUBLIC_LOGO_BYTES / 3) * 4 + 32 &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      input,
    )
  );
}

type LoadOptions = {
  env?: LogoEnvironment;
  signal?: AbortSignal;
  timeoutMs?: number;
  formats?: readonly string[];
  fetcher?: typeof fetch;
};

/** Fetch once with a byte/time bound, then pass bytes instead of a network URL to renderers. */
export async function loadPublicLogo(
  input?: string | null,
  options: LoadOptions = {},
): Promise<string | null> {
  const url = getPublicLogoUrl(input, options.env);
  if (!url) return null;
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (controller.signal.aborted) return null;
    const response = await (options.fetcher ?? fetch)(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok || response.redirected || !response.body) return null;
    const mime = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (
      !mime ||
      !(
        options.formats ?? [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
        ]
      ).includes(mime)
    )
      return null;
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_PUBLIC_LOGO_BYTES)
    )
      return null;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) return null;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PUBLIC_LOGO_BYTES) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const details = rasterDetails(bytes);
    if (
      !details ||
      details.mime !== mime ||
      details.width <= 0 ||
      details.height <= 0 ||
      details.width > MAX_LOGO_PIXELS / details.height
    )
      return null;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return `data:${mime};base64,${btoa(binary)}`;
  } catch {
    return null;
  } finally {
    controller.abort();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* Already closed or aborted. */
      }
      reader.releaseLock();
    }
  }
}

export async function isValidLogoUrl(url: string): Promise<boolean> {
  return (await loadPublicLogo(url)) !== null;
}
