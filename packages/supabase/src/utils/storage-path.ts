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
