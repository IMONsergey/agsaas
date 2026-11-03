export type InboxEnvironment = {
  INBOX_DOMAIN?: string;
  NEXT_PUBLIC_INBOX_DOMAIN?: string;
};

function configuredInboxEnvironment(): InboxEnvironment {
  return {
    INBOX_DOMAIN: process.env.INBOX_DOMAIN,
    NEXT_PUBLIC_INBOX_DOMAIN: process.env.NEXT_PUBLIC_INBOX_DOMAIN,
  };
}

/** Forwarding is disabled until this installation owns a configured domain. */
export function getInboxDomain(
  env: InboxEnvironment = configuredInboxEnvironment(),
): string | null {
  const domain = (env.INBOX_DOMAIN || env.NEXT_PUBLIC_INBOX_DOMAIN)
    ?.trim()
    .toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  )
    return null;
  if (domain === "midday.ai" || domain.endsWith(".midday.ai")) return null;
  if (
    env.INBOX_DOMAIN &&
    env.NEXT_PUBLIC_INBOX_DOMAIN &&
    env.INBOX_DOMAIN.trim().toLowerCase() !==
      env.NEXT_PUBLIC_INBOX_DOMAIN.trim().toLowerCase()
  )
    return null;
  return domain;
}

export function getInboxIdFromEmail(
  email: string,
  env?: InboxEnvironment,
): string | undefined {
  const parts = email.split("@");
  const domain = getInboxDomain(env);
  if (
    parts.length !== 2 ||
    !domain ||
    parts[1]?.toLowerCase() !== domain ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(parts[0] ?? "")
  )
    return undefined;
  return parts[0];
}

export type InboxOAuthProvider = "gmail" | "outlook";
export type InboxOAuthSource = "inbox" | "apps";
export const INBOX_OAUTH_TTL_SECONDS = 600;

/** Opaque 256-bit state/nonce; team/actor claims are held only by the database. */
export function isInboxOAuthToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function getInboxEmail(
  inboxId: string,
  env?: InboxEnvironment,
): string | null {
  const domain = getInboxDomain(env);
  if (!domain || !/^[a-zA-Z0-9_-]{1,64}$/.test(inboxId)) return null;
  return `${inboxId}@${domain}`;
}

/**
 * Determines if an error message indicates an authentication/authorization issue
 * that requires user intervention (like reconnecting their account) vs temporary
 * issues that might resolve on retry.
 *
 * Based on Google OAuth2 RFC 6749, Gmail API, and Google Auth Library patterns.
 *
 * @param errorMessage - The error message to analyze
 * @returns true if this is an authentication error requiring user action
 */
export function isAuthenticationError(errorMessage: string): boolean {
  if (!errorMessage) return false;

  const message = errorMessage.toLowerCase();

  // OAuth 2.0 error codes from RFC 6749
  const oauthErrors = [
    "invalid_request", // RFC 6749 - Malformed request
    "invalid_client", // RFC 6749 - Client authentication failed
    "invalid_grant", // RFC 6749 - Grant/refresh token invalid/expired
    "unauthorized_client", // RFC 6749 - Client not authorized for grant type
    "unsupported_grant_type", // RFC 6749 - Grant type not supported
    "invalid_scope", // RFC 6749 - Requested scope invalid/unknown
    "access_denied", // RFC 6749 - Resource owner denied request
    "invalid_token", // OAuth token validation failed
    "token_expired", // Token has expired
  ];

  // HTTP status codes indicating authentication issues
  const httpAuthErrors = [
    "401", // Unauthorized
    "403", // Forbidden
    "unauthorized", // Text version of 401
    "forbidden", // Text version of 403
    "unauthenticated", // gRPC equivalent of 401
  ];

  // Google-specific error patterns
  const googleSpecificErrors = [
    "authentication required",
    "re-authentication required",
    "reauthentication required",
    "authentication failed",
    "refresh token is invalid",
    "access token is invalid",
    "credentials have been revoked",
    "token has been expired or revoked",
    "invalid credentials",
    "permission denied",
    "insufficient permissions",
    "api key not valid",
    "api key expired",
  ];

  // Microsoft-specific error patterns
  const microsoftSpecificErrors = [
    "invalidauthenticationtoken", // Microsoft Graph error code
    "lifetime validation failed", // Token lifetime expired
    "token is expired", // Explicit expiration message
    "aadsts700082", // Refresh token expired
    "aadsts50076", // MFA required
    "aadsts700084", // Refresh token not found
    "aadsts65001", // User consent required
  ];

  // Combine all error patterns
  const allAuthPatterns = [
    ...oauthErrors,
    ...httpAuthErrors,
    ...googleSpecificErrors,
    ...microsoftSpecificErrors,
  ];

  return allAuthPatterns.some((pattern) => message.includes(pattern));
}
