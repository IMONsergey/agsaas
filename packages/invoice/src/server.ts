import sharp from "sharp";
import {
  type PreparedPdfLogo,
  PdfTemplate as PreparedPdfTemplate,
} from "./templates/pdf";
import type { Invoice } from "./types";
import {
  isInlineLogo,
  loadPublicLogo,
  MAX_PUBLIC_LOGO_BYTES,
} from "./utils/logo";

export { renderToBuffer, renderToStream } from "@react-pdf/renderer";

const MAX_INPUT_PIXELS = 16_000_000;
const MAX_OUTPUT_DIMENSION = 1024;

/** The package's explicit server entrypoint owns native decoding.
 * Only already-fetched raster bytes reach Sharp; never a URL or file path.
 * A newly encoded, bounded PNG reaches the PDF renderer, or the logo is omitted.
 */
async function preparePublicPdfLogo(
  input?: string | null,
): Promise<PreparedPdfLogo | null> {
  try {
    const inline = await loadPublicLogo(input, {
      formats: ["image/png", "image/jpeg"],
    });
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
      // Native processing time only; this excludes libuv queue wait.
      .timeout({ seconds: 3 })
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

    return `data:image/png;base64,${data.toString("base64")}` as PreparedPdfLogo;
  } catch {
    return null;
  }
}

export async function PdfTemplate(
  invoice: Invoice,
  options?: { isReceipt?: boolean },
) {
  const preparedLogo = await preparePublicPdfLogo(invoice.template?.logoUrl);
  return PreparedPdfTemplate(invoice, {
    isReceipt: options?.isReceipt,
    preparedLogo,
  });
}
