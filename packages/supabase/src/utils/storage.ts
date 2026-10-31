export const EMPTY_FOLDER_PLACEHOLDER_FILE_NAME = ".emptyFolderPlaceholder";

export class StoragePathError extends Error {
  constructor(readonly code: "INVALID_PATH" | "TEAM_MISMATCH") {
    super(
      code === "TEAM_MISMATCH"
        ? "File does not belong to the current team."
        : "Invalid storage path.",
    );
    this.name = "StoragePathError";
  }
}

/**
 * Validate an object key without changing its spelling. Storage clients embed
 * keys in URLs, so both literal and percent-encoded URL traversal are unsafe.
 * Decoding below is only for validation; callers always keep the original key.
 */
export function parseTeamStoragePath(path: string | readonly string[]): {
  path: string;
  teamId: string;
  segments: string[];
} {
  const value = typeof path === "string" ? path : path.join("/");
  const segments = value.split("/");
  const teamId = segments[0];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (segments.length < 2 || !teamId || !uuid.test(teamId)) {
    throw new StoragePathError("INVALID_PATH");
  }

  for (const segment of segments) {
    let candidate = segment;
    while (true) {
      if (
        !candidate ||
        candidate === "." ||
        candidate === ".." ||
        /[\\/?#\u0000-\u001f\u007f]/.test(candidate)
      ) {
        throw new StoragePathError("INVALID_PATH");
      }

      // Decode only escaped ASCII for safety checks. This also catches nested
      // escapes without rejecting literal percent signs or rewriting Unicode.
      const decoded = candidate.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
      if (decoded === candidate) break;
      candidate = decoded;
    }
  }

  return { path: value, teamId, segments };
}

export function assertTeamStoragePath(
  path: string | readonly string[],
  teamId: string,
): string {
  const parsed = parseTeamStoragePath(path);
  if (parsed.teamId !== teamId) {
    throw new StoragePathError("TEAM_MISMATCH");
  }
  return parsed.path;
}

type StorageClient = {
  storage: {
    from(bucket: string): any;
  };
};

type UploadParams = {
  file: File;
  path: string[];
  bucket: string;
};

export async function upload(
  client: StorageClient,
  { file, path, bucket }: UploadParams,
) {
  const storage = client.storage.from(bucket);

  const result = await storage.upload(path.join("/"), file, {
    upsert: true,
    cacheControl: "3600",
  });

  if (!result.error) {
    return storage.getPublicUrl(path.join("/")).data.publicUrl;
  }

  throw result.error;
}

type RemoveParams = {
  path: string[];
  bucket: string;
};

export async function remove(
  client: StorageClient,
  { bucket, path }: RemoveParams,
) {
  return client.storage
    .from(bucket)
    .remove([decodeURIComponent(path.join("/"))]);
}

type DownloadParams = {
  path: string;
  bucket: string;
};

export async function download(
  client: StorageClient,
  { bucket, path }: DownloadParams,
) {
  return client.storage.from(bucket).download(path);
}

type SignedUrlParams = {
  path: string;
  bucket: string;
  expireIn: number;
  options?: {
    download?: boolean;
  };
};

export async function signedUrl(
  client: StorageClient,
  { bucket, path, expireIn, options }: SignedUrlParams,
) {
  return client.storage.from(bucket).createSignedUrl(path, expireIn, options);
}
