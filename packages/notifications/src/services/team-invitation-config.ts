export type TeamInviteEmailConfig = {
  from: string;
  appUrl: string;
  productName: string;
};
export class TeamInvitationConfigurationError extends Error {
  constructor() {
    super("Invitation email is not configured");
    this.name = "TeamInvitationConfigurationError";
  }
}

/** Explicit own-instance configuration. Never fall back to an upstream sender
 * or URL. Missing optional email credentials do not affect worker startup. */
export function getTeamInviteEmailConfig(
  env: Record<string, string | undefined> = process.env,
): TeamInviteEmailConfig {
  const fail = (): never => {
    throw new TeamInvitationConfigurationError();
  };
  const from = env.EMAIL_FROM?.trim() ?? "";
  const appUrl = env.DASHBOARD_URL?.trim() ?? "";
  const productName = env.APP_NAME?.trim() || "AGSaaS";
  if (
    !env.RESEND_API_KEY?.trim() ||
    !from ||
    /[\r\n]/.test(from) ||
    /[\r\n]/.test(productName) ||
    productName.length > 80
  )
    return fail();
  const sender = from.includes("<")
    ? from.match(/^[^<>]+<([^<>]+)>$/)?.[1]
    : from;
  if (
    !sender ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(sender) ||
    /@(?:[^@.]+\.)*midday\.ai$/i.test(sender)
  )
    return fail();
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    return fail();
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /(^|\.)midday\.ai$/i.test(url.hostname)
  )
    return fail();
  return { from, appUrl: url.origin, productName };
}
