export type InstallationEnvironment = Record<string, string | undefined>;

// Explicit public reads allow Next.js to inline only the intended browser values.
function environment(): InstallationEnvironment {
  return {
    NODE_ENV: process.env.NODE_ENV,
    DASHBOARD_URL: process.env.DASHBOARD_URL,
    MIDDAY_DASHBOARD_URL: process.env.MIDDAY_DASHBOARD_URL,
    NEXT_PUBLIC_URL: process.env.NEXT_PUBLIC_URL,
    API_URL: process.env.API_URL,
    MIDDAY_API_URL: process.env.MIDDAY_API_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    EMAIL_URL: process.env.EMAIL_URL,
    CDN_URL: process.env.CDN_URL,
  };
}

/** Configuration is trusted only after validation; production never guesses an origin. */
export function installationOrigin(
  name: string,
  value: string | undefined,
  developmentDefault: string,
  env: InstallationEnvironment,
): string {
  const raw =
    value?.trim() ||
    (env.NODE_ENV === "production" ? undefined : developmentDefault);
  if (!raw) throw new Error(`${name} must be configured for this installation`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol === "http:" && !loopback) ||
    url.hostname === "midday.ai" ||
    url.hostname.endsWith(".midday.ai")
  ) {
    throw new Error(
      `${name} must be a secure installation origin without credentials, paths or upstream routing`,
    );
  }
  return url.origin;
}

export function getAppUrl(env: InstallationEnvironment = environment()) {
  return installationOrigin(
    "DASHBOARD_URL",
    env.DASHBOARD_URL || env.NEXT_PUBLIC_URL || env.MIDDAY_DASHBOARD_URL,
    "http://localhost:3001",
    env,
  );
}
export function getApiUrl(env: InstallationEnvironment = environment()) {
  return installationOrigin(
    "API_URL",
    env.API_URL || env.MIDDAY_API_URL || env.NEXT_PUBLIC_API_URL,
    "http://localhost:3003",
    env,
  );
}
export function getEmailUrl(env: InstallationEnvironment = environment()) {
  return env.EMAIL_URL
    ? installationOrigin(
        "EMAIL_URL",
        env.EMAIL_URL,
        "http://localhost:3001",
        env,
      )
    : getAppUrl(env);
}
export function getCdnUrl(env: InstallationEnvironment = environment()) {
  return env.CDN_URL
    ? installationOrigin("CDN_URL", env.CDN_URL, "http://localhost:3001", env)
    : getAppUrl(env);
}
