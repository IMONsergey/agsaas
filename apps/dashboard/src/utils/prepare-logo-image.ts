import { PUBLIC_IMAGE_ACCEPT } from "./public-image-upload";

/** Normalize a logo locally so every invoice renderer receives a static PNG. */
export async function prepareLogoImage(file: File): Promise<File> {
  if (
    !PUBLIC_IMAGE_ACCEPT.split(",").includes(file.type) ||
    file.size <= 0 ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("Choose a supported image no larger than 5 MiB.");
  const bitmap = await createImageBitmap(file);
  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width > 16_000_000 / bitmap.height
    )
      throw new Error("Choose an image with no more than 16 million pixels.");
    const scale = Math.min(1, 1024 / bitmap.width, 1024 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Image preparation is unavailable in this browser.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error("Image preparation failed.")),
        "image/png",
      );
    });
    if (blob.size > 5 * 1024 * 1024)
      throw new Error("The prepared logo is too large.");
    return new File([blob], "logo.png", { type: "image/png" });
  } finally {
    bitmap.close();
  }
}
