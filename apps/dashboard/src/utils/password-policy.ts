export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
export const PASSWORD_RECOVERY_MAX_AGE_SECONDS = 15 * 60;

/** Only call this with claims returned by Supabase's verified getClaims(). */
export function isFreshPasswordRecovery(
  claims: unknown,
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!claims || typeof claims !== "object") return false;
  const value = claims as Record<string, unknown>;
  if (
    value.sub !== userId ||
    value.role !== "authenticated" ||
    (value.aud !== "authenticated" &&
      !(Array.isArray(value.aud) && value.aud.includes("authenticated"))) ||
    typeof value.session_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.session_id,
    ) ||
    typeof value.exp !== "number" ||
    !Number.isFinite(value.exp) ||
    value.exp <= nowSeconds ||
    !Array.isArray(value.amr)
  )
    return false;
  return value.amr.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const method = entry as Record<string, unknown>;
    return (
      method.method === "recovery" &&
      typeof method.timestamp === "number" &&
      Number.isInteger(method.timestamp) &&
      method.timestamp <= nowSeconds + 30 &&
      method.timestamp > nowSeconds - PASSWORD_RECOVERY_MAX_AGE_SECONDS
    );
  });
}
