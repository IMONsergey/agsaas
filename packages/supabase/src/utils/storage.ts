import { validateStorageKey, validateVaultKey } from "./storage-path";

export const EMPTY_FOLDER_PLACEHOLDER_FILE_NAME = ".emptyFolderPlaceholder";

function storageKey(bucket: string, path: string): string {
  return bucket === "vault"
    ? validateVaultKey(path).normalizedPath
    : validateStorageKey(path);
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
  const key = storageKey(bucket, path.join("/"));
  const storage = client.storage.from(bucket);

  const result = await storage.upload(key, file, {
    upsert: true,
    cacheControl: "3600",
  });

  if (!result.error) {
    return storage.getPublicUrl(key).data.publicUrl;
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
    .remove([storageKey(bucket, path.join("/"))]);
}

type DownloadParams = {
  path: string;
  bucket: string;
};

export async function download(
  client: StorageClient,
  { bucket, path }: DownloadParams,
) {
  return client.storage.from(bucket).download(storageKey(bucket, path));
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
  return client.storage
    .from(bucket)
    .createSignedUrl(storageKey(bucket, path), expireIn, options);
}
