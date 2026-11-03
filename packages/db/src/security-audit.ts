/** Strict metadata allowlist. Credentials, email addresses, request bodies and free text are never recorded. */
export function securityAuditMetadata(input: Record<string, unknown> = {}) {
  const output: Record<string, string | number | boolean | string[]> = {};
  for (const key of ["beforeScopes", "afterScopes", "settingIds"] as const) {
    const value = input[key];
    if (Array.isArray(value))
      output[key] = value
        .filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            /^[a-z][a-z0-9_.:-]{0,63}$/i.test(entry),
        )
        .slice(0, 100);
  }
  for (const key of [
    "provider",
    "status",
    "reason",
    "beforeRole",
    "afterRole",
    "source",
    "scope",
  ] as const) {
    const value = input[key];
    if (typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/i.test(value))
      output[key] = value;
  }
  for (const key of [
    "configurationChanged",
    "settingsChanged",
    "nameChanged",
    "connected",
  ] as const)
    if (typeof input[key] === "boolean") output[key] = input[key] as boolean;
  for (const key of ["count", "attempt"] as const)
    if (
      typeof input[key] === "number" &&
      Number.isSafeInteger(input[key]) &&
      (input[key] as number) >= 0
    )
      output[key] = input[key] as number;
  return output;
}
