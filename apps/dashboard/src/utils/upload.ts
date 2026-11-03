import { stripSpecialCharacters } from "@midday/utils";
import { installationOrigin } from "@midday/utils/envs";
import { requireVaultPathForTeam } from "@midday/utils/storage-path";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as tus from "tus-js-client";

export type PreparedVaultUpload = {
  file: File;
  path: string[];
  filename: string;
  displayName: string;
  filePath: string[];
};
export type ResumableUploadResult = {
  file: File;
  filename: string;
  filePath: string[];
};

export function prepareVaultUploads(
  files: File[],
  basePath: string[],
): PreparedVaultUpload[] {
  if (files.length < 1 || files.length > 25)
    throw new Error("Select between 1 and 25 files.");
  return files.map((file) => {
    if (!file.size || file.size > 5_000_000)
      throw new Error("Each upload must be between 1 byte and 5 MB.");
    const filename =
      stripSpecialCharacters(file.name).replace(/^\.+/, "").slice(-180) ||
      "file";
    // Keep the human filename, but give every object its own immutable identity.
    const path = [...basePath, crypto.randomUUID()];
    const filePath = [...path, filename];
    requireVaultPathForTeam(filePath, basePath[0] ?? "");
    return {
      file,
      path,
      filename,
      filePath,
      displayName: file.name.trim().slice(0, 200) || filename,
    };
  });
}

export function resumableEndpoint(
  value = process.env.NEXT_PUBLIC_SUPABASE_URL,
) {
  const origin = installationOrigin(
    "NEXT_PUBLIC_SUPABASE_URL",
    value,
    "http://localhost:54321",
    {
      NODE_ENV: process.env.NODE_ENV,
    },
  );
  return new URL("/storage/v1/upload/resumable", origin).href;
}

function isUploadUrl(value: string | null, endpoint: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const base = new URL(endpoint);
    return (
      url.origin === base.origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === base.pathname ||
        url.pathname.startsWith(base.pathname + "/"))
    );
  } catch {
    return false;
  }
}

type ResumableUploadParams = Pick<
  PreparedVaultUpload,
  "file" | "path" | "filename"
> & {
  bucket: "vault";
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
};

export async function resumableUpload(
  client: SupabaseClient,
  { file, path, filename, bucket, onProgress }: ResumableUploadParams,
): Promise<ResumableUploadResult> {
  const filePath = [...path, filename];
  const fullPath = requireVaultPathForTeam(
    filePath,
    path[0] ?? "",
  ).normalizedPath;
  const endpoint = resumableEndpoint();
  const {
    data: { session },
    error,
  } = await client.auth.getSession();
  if (error || !session?.access_token || !session.user.id)
    throw new Error("Sign in again before uploading.");
  const userId = session.user.id;
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!publicKey)
    throw new Error("Storage is not configured for this installation.");

  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint,
      retryDelays: [0, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: publicKey,
      },
      // A retry may resume this exact object, but cannot overwrite another file.
      fingerprint: async () =>
        JSON.stringify([
          "agsaas-vault-v1",
          endpoint,
          userId,
          bucket,
          fullPath,
          file.size,
          file.type,
          file.lastModified,
        ]),
      onBeforeRequest: async (request) => {
        if (!isUploadUrl(request.getURL(), endpoint))
          throw new Error(
            "The upload endpoint changed. Start the upload again.",
          );
        const current = await client.auth.getSession();
        if (
          current.error ||
          !current.data.session?.access_token ||
          current.data.session.user.id !== userId
        )
          throw new Error(
            "The signed-in account changed. Start the upload again.",
          );
        request.setHeader(
          "authorization",
          `Bearer ${current.data.session.access_token}`,
        );
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucket,
        objectName: fullPath,
        contentType: file.type,
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024,
      onError: reject,
      onProgress,
      onSuccess: () => resolve({ file, filename, filePath }),
    });
    void upload
      .findPreviousUploads()
      .then((previousUploads) => {
        const previous = previousUploads.find(
          (item) =>
            item.size === file.size &&
            item.metadata.bucketName === bucket &&
            item.metadata.objectName === fullPath &&
            !item.parallelUploadUrls?.length &&
            isUploadUrl(item.uploadUrl, endpoint),
        );
        if (previous) upload.resumeFromPreviousUpload(previous);
        upload.start();
      })
      .catch(reject);
  });
}
