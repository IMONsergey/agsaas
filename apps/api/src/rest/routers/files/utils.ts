import { teamCache } from "@midday/cache/team-cache";
import type { Database } from "@midday/db/client";
import { hasTeamAccess } from "@midday/db/queries";
import { validateVaultKey } from "@midday/supabase/storage-path";
import { HTTPException } from "hono/http-exception";

/**
 * Normalize and validate file path
 * Extracts teamId from path and validates format
 */
export function normalizeAndValidatePath(filePath: string): {
  normalizedPath: string;
  pathTeamId: string;
  pathArray: string[];
} {
  try {
    return validateVaultKey(filePath);
  } catch {
    throw new HTTPException(400, {
      message:
        "Invalid file path. A canonical team-scoped storage key is required.",
    });
  }
}

/**
 * Validate user has access to team using cache
 * Uses team cache for fast lookups, falls back to efficient DB query on cache miss
 */
export async function validateTeamAccess(
  db: Database,
  userId: string,
  teamId: string,
): Promise<void> {
  const cacheKey = `user:${userId}:team:${teamId}`;
  let hasAccess = await teamCache.get(cacheKey);

  if (hasAccess === undefined) {
    // Cache miss - use efficient hasTeamAccess query (direct join, no user lookup)
    hasAccess = await hasTeamAccess(db, teamId, userId);
    await teamCache.set(cacheKey, hasAccess);
  }

  if (!hasAccess) {
    throw new HTTPException(403, {
      message: "Access denied. File does not belong to your team.",
    });
  }
}

/**
 * Get content type from filename extension
 */
export function getContentTypeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const contentTypes: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    zip: "application/zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return contentTypes[ext || ""] || "application/octet-stream";
}

/** RFC 5987 name plus a safe ASCII fallback, including for legacy invoice names. */
export function attachmentDisposition(filename: string): string {
  const name = filename.slice(0, 240);
  const fallback = Array.from(name, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code > 126 || ['"', "\\", "/"].includes(char)
      ? "_"
      : char;
  }).join("");
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback || "download"}"; filename*=UTF-8''${encoded}`;
}
