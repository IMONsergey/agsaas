const AUTH_PROVIDERS = [
  "email",
  "password",
  "google",
  "apple",
  "azure",
  "github",
] as const;

export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

function isAuthProvider(value: string): value is AuthProvider {
  return AUTH_PROVIDERS.some((provider) => provider === value);
}

/** Pure parser. The environment is read only by auth-methods.server.ts. */
export function parseEnabledAuthProviders(value?: string): AuthProvider[] {
  if (!value?.trim()) return ["email"];

  const providers: AuthProvider[] = [];
  for (const raw of value.split(",")) {
    const provider = raw.trim();
    if (!isAuthProvider(provider) || providers.includes(provider)) {
      // Do not echo operator input: an accidental value could be a secret.
      throw new Error(
        "AUTH_ENABLED_PROVIDERS must contain distinct supported sign-in methods",
      );
    }
    providers.push(provider);
  }
  return providers;
}

export function selectSignInOptions(
  enabled: readonly AuthProvider[],
  preferred?: string,
): { primary: AuthProvider; alternatives: AuthProvider[] } {
  const first = enabled[0];
  if (!first) throw new Error("No sign-in method is configured");
  // Existing deployments store the email OTP preference as "otp".
  const preference = preferred === "otp" ? "email" : preferred;
  const primary =
    preference && isAuthProvider(preference) && enabled.includes(preference)
      ? preference
      : first;
  return {
    primary,
    alternatives: enabled.filter((provider) => provider !== primary),
  };
}
