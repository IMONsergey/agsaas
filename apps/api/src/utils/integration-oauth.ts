import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@api/rest/types";
import { MfaPolicyError, requireSessionMfa } from "@api/utils/mfa";
import type { TransactionClient } from "@midday/db/client";
import { TeamMembershipError } from "@midday/db/errors";
import {
  completeIntegrationOAuthIntent,
  consumeIntegrationOAuthIntent,
  createIntegrationOAuthIntent,
  findIntegrationOAuthIntent,
  type IntegrationOAuthIntent,
  type IntegrationOAuthProvider,
} from "@midday/db/queries";
import type { Context as HonoContext } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

type OAuthContext = HonoContext<Context>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const isToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const invalid = () => new HTTPException(400, { message: "Invalid or expired connection. Please start again." });

function origin(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url;
  } catch {
    throw new HTTPException(503, { message: "Integration callback is not configured" });
  }
}
export function getIntegrationOAuthConfiguration(provider: IntegrationOAuthProvider) {
  const api = origin(process.env.API_URL || process.env.MIDDAY_API_URL);
  const dashboard = origin(process.env.DASHBOARD_URL || process.env.MIDDAY_DASHBOARD_URL);
  const path = provider === "stripe" ? "/invoice-payments/connect-stripe/callback" : `/apps/${provider}/oauth-callback`;
  const redirectUri = `${api.origin}${path}`;
  const prefix = provider.toUpperCase();
  if (provider === "stripe") {
    if (!process.env.STRIPE_CONNECT_CLIENT_ID || !process.env.STRIPE_SECRET_KEY) throw new HTTPException(503, { message: "Stripe Connect is not configured" });
  } else if (!process.env[`${prefix}_CLIENT_ID`] || !process.env[`${prefix}_CLIENT_SECRET`] || process.env[`${prefix}_OAUTH_REDIRECT_URL`] !== redirectUri) {
    throw new HTTPException(503, { message: "Integration callback is not configured" });
  }
  const secure = api.protocol === "https:";
  return {
    dashboardUrl: dashboard.origin,
    redirectUri,
    cookieName: `${secure ? "__Secure-" : ""}agsaas-integration-oauth-${provider}`,
    cookieOptions: { path, httpOnly: true, secure, sameSite: "Lax" as const },
  };
}
async function requireMfa(intent: Pick<IntegrationOAuthIntent, "userId" | "aal">) {
  try {
    await requireSessionMfa({ user: { id: intent.userId }, aal: intent.aal });
  } catch (error) {
    if (error instanceof MfaPolicyError) throw new HTTPException(error.reason === "required" ? 403 : 503, { message: error.message });
    throw new HTTPException(503, { message: "Unable to verify authentication" });
  }
}

/** Only an authenticated interactive POST creates a browser-bound owner intent. */
export async function startIntegrationOAuth(c: OAuthContext, provider: IntegrationOAuthProvider) {
  const config = getIntegrationOAuthConfiguration(provider);
  const session = c.get("session");
  const teamId = c.get("teamId");
  if (c.get("authType") !== "session" || !session?.user.id || !teamId || !session.aal) {
    throw new HTTPException(403, { message: "Sign in as a team owner to connect an integration" });
  }
  await requireMfa({ userId: session.user.id, aal: session.aal });
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  try {
    await createIntegrationOAuthIntent(c.get("db"), {
      stateHash: digest(state), browserNonceHash: digest(nonce),
      userId: session.user.id, teamId, provider,
      source: provider === "stripe" ? "invoice-settings" : "apps", aal: session.aal,
    });
  } catch (error) {
    if (error instanceof TeamMembershipError) throw new HTTPException(403, { message: "A current team owner is required" });
    throw new HTTPException(503, { message: "Unable to start integration connection" });
  }
  setCookie(c, config.cookieName, nonce, { ...config.cookieOptions, maxAge: 600 });
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  return { state, ...config };
}

/** No bearer survives provider navigation; the authenticated start's HttpOnly nonce proves the browser. */
export async function consumeIntegrationOAuth(c: OAuthContext, provider: IntegrationOAuthProvider, state: string) {
  const config = getIntegrationOAuthConfiguration(provider);
  const nonce = getCookie(c, config.cookieName);
  if (!isToken(state) || !isToken(nonce)) throw invalid();
  const binding = { stateHash: digest(state), browserNonceHash: digest(nonce), provider };
  try {
    const candidate = await findIntegrationOAuthIntent(c.get("db"), binding);
    if (!candidate) throw invalid();
    await requireMfa(candidate);
    const intent = await consumeIntegrationOAuthIntent(c.get("db"), binding);
    if (!intent) throw invalid();
    deleteCookie(c, config.cookieName, config.cookieOptions);
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    return { ...intent, ...config };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(503, { message: "Unable to verify integration connection" });
  }
}

export async function completeIntegrationOAuth<T>(c: OAuthContext, intent: IntegrationOAuthIntent, write: (tx: TransactionClient) => Promise<T>) {
  await requireMfa(intent);
  return completeIntegrationOAuthIntent(c.get("db"), intent, write);
}
