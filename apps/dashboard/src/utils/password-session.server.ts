import "server-only";
import { createClient } from "@midday/supabase/server";
import { getTRPCClient } from "@/trpc/server";
import { getPasswordCapabilities } from "./password-config.server";
import { isFreshPasswordRecovery } from "./password-policy";

export const PASSWORD_SESSION_ERROR =
  "Sign in and verify your identity before changing your password.";
export const PASSWORD_RECOVERY_ERROR =
  "This password reset link is invalid or has expired. Request a new link.";

/** Enforce current primary profile and authoritative MFA policy via the API. */
export async function requirePasswordSession(
  options: { recovery?: boolean } = {},
) {
  const message = options.recovery
    ? PASSWORD_RECOVERY_ERROR
    : PASSWORD_SESSION_ERROR;
  try {
    const capabilities = getPasswordCapabilities();
    if (
      !capabilities.passwordChange.enabled ||
      (options.recovery && !capabilities.passwordRecovery.enabled)
    )
      throw new Error();
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.id || !data.user.email) throw new Error();
    if (options.recovery) {
      const { data: verified, error: claimsError } =
        await supabase.auth.getClaims();
      if (
        claimsError ||
        !isFreshPasswordRecovery(verified?.claims, data.user.id)
      )
        throw new Error();
    }
    const api = await getTRPCClient({ forcePrimary: true });
    const profile = await api.user.me.query();
    if (!profile || profile.id !== data.user.id || profile.deletionStartedAt)
      throw new Error();
    return { supabase, user: data.user };
  } catch {
    // Never surface Auth errors, request diagnostics, credentials or tokens.
    throw new Error(message);
  }
}
