/** Storage keys are identifiers, never URLs or paths to normalize. */
export class InvalidStorageKeyError extends Error {
  constructor() {
    super(
      "Invalid storage key. Use a canonical path without encoded or relative segments.",
    );
    this.name = "InvalidStorageKeyError";
  }
}

export function validateStorageKey(key: string): string {
  // Reject ambiguous keys before URL parsers or Storage transports can decode
  // percent sequences or collapse dot segments into another team's namespace.
  if (
    !key ||
    key.length > 1024 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls before URL normalization can change a tenant-scoped storage key.
    /[%\\?#\u0000-\u001f\u007f]/.test(key) ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new InvalidStorageKeyError();
  }
  return key;
}

export function validateVaultKey(filePath: string): {
  normalizedPath: string;
  pathTeamId: string;
  pathArray: string[];
} {
  const normalizedPath = validateStorageKey(
    filePath.startsWith("vault/") ? filePath.slice("vault/".length) : filePath,
  );
  const pathArray = normalizedPath.split("/");
  const pathTeamId = pathArray[0];
  if (
    pathArray.length < 2 ||
    !pathTeamId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      pathTeamId,
    )
  ) {
    throw new InvalidStorageKeyError();
  }
  return { normalizedPath, pathTeamId, pathArray };
}

const TEAM_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fail closed before an elevated client can read or write a tenant object. */
export function requireVaultPathForTeam(
  path: string | readonly string[],
  teamId: string,
) {
  if (!TEAM_ID.test(teamId)) throw new InvalidStorageKeyError();
  if (
    Array.isArray(path) &&
    path.some((segment) => typeof segment !== "string" || segment.includes("/"))
  ) {
    throw new InvalidStorageKeyError();
  }
  if (
    typeof path !== "string" &&
    path[0]?.toLowerCase() !== teamId.toLowerCase()
  ) {
    throw new InvalidStorageKeyError();
  }
  const key = typeof path === "string" ? path : path.join("/");
  const parsed = validateVaultKey(key);
  if (parsed.pathTeamId.toLowerCase() !== teamId.toLowerCase()) {
    throw new InvalidStorageKeyError();
  }
  return parsed;
}

/** Listing may use the team root, but never the whole private bucket. */
export function requireVaultPrefixForTeam(prefix: string, teamId: string) {
  if (!TEAM_ID.test(teamId)) throw new InvalidStorageKeyError();
  const key = validateStorageKey(prefix);
  if (key.toLowerCase() === teamId.toLowerCase()) return key;
  return requireVaultPathForTeam(key, teamId).normalizedPath;
}
