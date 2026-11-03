export const PUBLIC_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";
export const PUBLIC_IMAGE_NOTICE =
  "Visible to anyone with the image link. PNG, JPEG, WebP or GIF, up to 5 MiB.";
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
type Purpose =
  | "user-avatar"
  | "team-logo"
  | "invoice-logo"
  | "app-logo"
  | "app-screenshot";

/** Fresh immutable names prevent replacement of already shared invoice assets. */
export function publicImagePath(
  file: Pick<File, "type" | "size">,
  id: string,
  purpose: Purpose,
): string[] {
  const extension = EXTENSIONS[file.type];
  if (!extension || file.size <= 0 || file.size > 5 * 1024 * 1024)
    throw new Error(
      "Choose a PNG, JPEG, WebP or GIF image no larger than 5 MiB.",
    );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  )
    throw new Error("Your account or workspace is not ready for this upload.");
  const name = `${crypto.randomUUID()}.${extension}`;
  switch (purpose) {
    case "user-avatar":
      return ["users", id, name];
    case "team-logo":
      return ["teams", id, "logo", name];
    case "invoice-logo":
      return ["teams", id, "invoice", name];
    case "app-logo":
      return [id, "logos", name];
    case "app-screenshot":
      return [id, "screenshots", name];
  }
}
