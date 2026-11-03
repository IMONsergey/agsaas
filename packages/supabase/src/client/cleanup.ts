import { createClient } from "@supabase/supabase-js";
import { createSupabaseFetch, withFetchAbortSignal } from "./server-fetch";

export type StorageCleanupScope =
  | { teamId: string; userId?: never }
  | { userId: string; teamId?: never };
export function assertCleanupStoragePaths(
  scope: StorageCleanupScope,
  bucket: string,
  paths: readonly string[],
) {
  if (Boolean(scope.teamId) === Boolean(scope.userId))
    throw new Error("Exactly one storage cleanup scope is required");
  const id = scope.teamId ?? scope.userId;
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id,
    ) ||
    paths.length < 1 ||
    paths.length > 100
  )
    throw new Error("Invalid storage cleanup scope");
  const prefix = scope.teamId
    ? bucket === "vault" || bucket === "apps"
      ? `${scope.teamId}/`
      : bucket === "avatars"
        ? `teams/${scope.teamId}/`
        : null
    : bucket === "avatars"
      ? `users/${scope.userId}/`
      : null;
  if (
    !prefix ||
    paths.some(
      (path) =>
        typeof path !== "string" ||
        path.length > 2048 ||
        !path.startsWith(prefix) ||
        /[%\\?#]/.test(path) ||
        Array.from(path).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ) ||
        path.split("/").some((part) => !part || part === "." || part === ".."),
    )
  )
    throw new Error("Storage cleanup target is outside its retained scope");
}

/** Delete-only capability. It cannot read, list, sign, or upload any object. */
export function createStorageCleanupClient(scope: StorageCleanupScope) {
  return {
    async remove(bucket: string, paths: string[]) {
      assertCleanupStoragePaths(scope, bucket, paths);
      const url =
        process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SECRET_KEY;
      if (!url || !key) throw new Error("Storage cleanup is not configured");
      const boundedFetch = createSupabaseFetch(url);
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: withFetchAbortSignal(boundedFetch, () =>
            AbortSignal.timeout(10_000),
          ),
        },
      });
      const { error } = await client.storage.from(bucket).remove(paths);
      if (error) throw new Error("Storage cleanup was not confirmed");
    },
  };
}
