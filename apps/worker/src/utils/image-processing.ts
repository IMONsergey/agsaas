import type { createLoggerWithContext } from "@midday/logger";
import { documentInputBase64, runDocumentTask } from "./document-isolation";
import { IMAGE_SIZES } from "./timeout";
export const MAX_HEIC_FILE_SIZE = 15 * 1024 * 1024;
export interface HeicConversionResult {
  buffer: Buffer;
  mimetype: "image/jpeg";
}
export interface ImageProcessingOptions {
  maxSize?: number;
}
export interface ResizeResult {
  buffer: Buffer;
  mimetype: string;
}
export async function resizeImage(
  inputBuffer: ArrayBuffer,
  mimetype: string,
  _logger: ReturnType<typeof createLoggerWithContext>,
  options?: ImageProcessingOptions,
): Promise<ResizeResult> {
  const result = await runDocumentTask(
    {
      kind: "image",
      base64: documentInputBase64(inputBuffer),
      mimetype,
      maxSize: options?.maxSize ?? IMAGE_SIZES.MAX_DIMENSION,
    },
    { timeoutMs: 30_000 },
  );
  return {
    buffer: Buffer.from(result.base64, "base64"),
    mimetype: result.mimetype,
  };
}
export async function convertHeicToJpeg(
  inputBuffer: ArrayBuffer,
  logger: ReturnType<typeof createLoggerWithContext>,
  options?: ImageProcessingOptions,
): Promise<HeicConversionResult> {
  if (inputBuffer.byteLength > MAX_HEIC_FILE_SIZE)
    throw new Error("HEIC processing accepts files up to 15 MiB");
  const result = await resizeImage(inputBuffer, "image/heic", logger, options);
  return { buffer: result.buffer, mimetype: "image/jpeg" };
}
