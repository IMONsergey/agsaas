import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Handler } from "hono";

/** Vite emits flat asset names. Never interpret a decoded route parameter as a path. */
export function getAssetPath(
  assetsDirectory: string,
  fileName: string,
): string | null {
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    [...fileName].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }

  return join(assetsDirectory, fileName);
}

export function createAssetHandler(assetsDirectory: string): Handler {
  return (c) => {
    const fileName = c.req.param("file") ?? "";
    const filePath = getAssetPath(assetsDirectory, fileName);

    if (
      !filePath ||
      !existsSync(filePath) ||
      !statSync(filePath, { throwIfNoEntry: false })?.isFile()
    ) {
      return c.text("Not found", 404);
    }

    const content = readFileSync(filePath);
    const contentType = fileName.endsWith(".js")
      ? "application/javascript"
      : fileName.endsWith(".css")
        ? "text/css"
        : "application/octet-stream";

    return c.body(content, 200, { "Content-Type": contentType });
  };
}
