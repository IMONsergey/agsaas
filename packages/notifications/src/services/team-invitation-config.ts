import {
  getProductEmailConfig,
  type ProductEmailConfig,
  requireProductEmailTransport,
} from "@midday/email/config";

export type TeamInviteEmailConfig = ProductEmailConfig;
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
  try {
    requireProductEmailTransport(env);
    return getProductEmailConfig(env);
  } catch {
    throw new TeamInvitationConfigurationError();
  }
}
