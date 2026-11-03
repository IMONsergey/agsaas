import "server-only";
import {
  isInlineLogo,
  loadPublicLogo,
  MAX_PUBLIC_LOGO_BYTES,
} from "@midday/invoice";
import sharp from "sharp";

const MAX_INPUT_PIXELS = 16_000_000;
const MAX_OUTPUT_DIMENSION = 1024;
const PROCESSING_TIMEOUT_SECONDS = 3;

/** Optional OG logos are fully decoded before Satori sees them.
 * The common loader owns origin, redirect, MIME, byte and fetch-time limits.
 * Sharp receives only its already-fetched raster bytes, never a URL or path.
 */
export async function loadPublicOgLogo(
  input?: string | null,
): Promise<string | null> {
  try {
    const inline = await loadPublicLogo(input);
    if (!isInlineLogo(inline)) return null;
    const bytes = Buffer.from(inline.slice(inline.indexOf(",") + 1), "base64");
    if (!bytes.length || bytes.length > MAX_PUBLIC_LOGO_BYTES) return null;

    const { data, info } = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: MAX_INPUT_PIXELS,
      page: 0,
      pages: 1,
      animated: false,
      autoOrient: true,
    })
      .resize({
        width: MAX_OUTPUT_DIMENSION,
        height: MAX_OUTPUT_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      // Native processing timeout; libuv queue wait is not included.
      .timeout({ seconds: PROCESSING_TIMEOUT_SECONDS })
      .toBuffer({ resolveWithObject: true });

    if (
      info.format !== "png" ||
      !Number.isInteger(info.width) ||
      !Number.isInteger(info.height) ||
      info.width < 1 ||
      info.height < 1 ||
      info.width > MAX_OUTPUT_DIMENSION ||
      info.height > MAX_OUTPUT_DIMENSION ||
      !data.length ||
      data.length > MAX_PUBLIC_LOGO_BYTES
    )
      return null;

    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    // A missing, corrupt, unsupported or timed-out optional logo must not
    // prevent a valid public record from producing its preview.
    return null;
  }
}
