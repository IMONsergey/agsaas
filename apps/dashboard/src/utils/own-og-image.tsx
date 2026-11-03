import { getOwnedOgFonts } from "@midday/invoice";
import type { ReactNode } from "react";
import satori from "satori";
import sharp from "sharp";

/** Fixed-size public previews use bundled fonts and validated inline images.
 * Omitting loadAdditionalAsset is deliberate: missing glyphs cannot trigger
 * Next's implicit Google Fonts or emoji CDN requests. Latin and Cyrillic are
 * covered by the bundled font. Other scripts need an explicitly bundled font.
 */
export async function ownOgImageResponse(
  element: ReactNode,
  options: { width: 1200; height: 630 },
): Promise<Response> {
  const svg = await satori(element, {
    ...options,
    fonts: await getOwnedOgFonts(),
    embedFont: true,
  });
  const bytes = await sharp(Buffer.from(svg), {
    limitInputPixels: options.width * options.height,
    failOn: "warning",
  })
    .png()
    .toBuffer();
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
