import {
  InvalidStorageKeyError,
  requireVaultPathForTeam,
  requireVaultPrefixForTeam,
} from "@midday/utils/storage-path";

const singlePathMethods = new Set([
  "download",
  "upload",
  "update",
  "createSignedUrl",
  "createSignedUploadUrl",
  "uploadToSignedUrl",
  "info",
  "exists",
  "getPublicUrl",
]);

/**
 * Bind service-role Storage to a single tenant. Validate before the SDK builds
 * a URL: URL normalization must never turn an untrusted path into another key.
 * Batch and source/destination operations are validated atomically before IO.
 * New SDK methods are unavailable until their path semantics are reviewed.
 */
export function withTeamStorage<T extends { storage: object }>(
  client: T,
  teamId: string,
): T {
  requireVaultPrefixForTeam(teamId, teamId);
  const storage = new Proxy(client.storage, {
    get(target, property) {
      if (property !== "from") {
        throw new InvalidStorageKeyError();
      }
      return (bucket: string) => {
        if (bucket !== "vault") throw new InvalidStorageKeyError();
        const from = Reflect.get(target, "from");
        const bucketClient = Reflect.apply(from, target, [bucket]);
        if (!bucketClient || typeof bucketClient !== "object") throw new InvalidStorageKeyError();
        return new Proxy(bucketClient, {
          get(bucketTarget, method) {
            const value = Reflect.get(bucketTarget, method);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              const key = (value: unknown) => {
                if (typeof value !== "string")
                  throw new InvalidStorageKeyError();
                return requireVaultPathForTeam(value, teamId).normalizedPath;
              };
              if (typeof method === "string" && singlePathMethods.has(method)) {
                args[0] = key(args[0]);
              } else if (method === "remove" || method === "createSignedUrls") {
                if (!Array.isArray(args[0])) throw new InvalidStorageKeyError();
                args[0] = args[0].map(key);
              } else if (method === "move" || method === "copy") {
                args[0] = key(args[0]);
                args[1] = key(args[1]);
                const options = args[2] as
                  | { destinationBucket?: string }
                  | undefined;
                if (
                  options?.destinationBucket &&
                  options.destinationBucket !== "vault"
                ) {
                  throw new InvalidStorageKeyError();
                }
              } else if (method === "list") {
                if (typeof args[0] !== "string")
                  throw new InvalidStorageKeyError();
                args[0] = requireVaultPrefixForTeam(args[0], teamId);
              } else {
                throw new InvalidStorageKeyError();
              }
              return Reflect.apply(value, bucketTarget, args);
            };
          },
        });
      };
    },
  });
  return new Proxy(client, {
    get(target, property) {
      if (property === "storage") return storage;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
