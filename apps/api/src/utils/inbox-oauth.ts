import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@api/rest/types";
import { getInstanceCapabilities } from "@api/utils/instance-capabilities";
import { MfaPolicyError, requireSessionMfa } from "@api/utils/mfa";
import {
  consumeInboxOAuthIntent,
  createInboxOAuthIntent,
} from "@midday/db/queries";
import { InboxConnector } from "@midday/inbox/connector";
import {
  INBOX_OAUTH_TTL_SECONDS,
  type InboxOAuthProvider,
  type InboxOAuthSource,
  isInboxOAuthToken,
} from "@midday/inbox/utils";
import { sanitizeRedirectPath } from "@midday/utils/sanitize-redirect";
import type { Context as HonoContext } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

type InboxContext = HonoContext<Context>;

function canonicalUrl(raw: string | undefined): URL {
  try {
    const url = new URL(raw ?? "");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    return url;
  } catch {
    throw new HTTPException(503, {
      message: "Inbox connection is not configured",
    });
  }
}

export function getInboxOAuthConfiguration(provider: InboxOAuthProvider) {
  if (!getInstanceCapabilities().integrations[provider]?.enabled) {
    throw new HTTPException(503, {
      message: "Inbox connection is not configured",
    });
  }
  const api = canonicalUrl(process.env.API_URL || process.env.MIDDAY_API_URL);
  const dashboard = canonicalUrl(
    process.env.DASHBOARD_URL || process.env.MIDDAY_DASHBOARD_URL,
  );
  const path = `/apps/${provider}/oauth-callback`;
  const redirectUri =
    provider === "gmail"
      ? process.env.GMAIL_REDIRECT_URI
      : process.env.OUTLOOK_REDIRECT_URI;
  // Do not send provider credentials/codes to an old upstream callback URL.
  if (redirectUri !== `${api.origin}${path}`) {
    throw new HTTPException(503, {
      message: "Inbox connection is not configured",
    });
  }
  const secure = api.protocol === "https:";
  return {
    dashboardUrl: dashboard.origin,
    cookieName: `${secure ? "__Secure-" : ""}agsaas-inbox-oauth-${provider}`,
    cookieOptions: { path, httpOnly: true, secure, sameSite: "Lax" as const },
  };
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Called only after REST Bearer authorization, never by a public GET. */
export async function startInboxOAuth(
  c: InboxContext,
  provider: InboxOAuthProvider,
  input: { source: InboxOAuthSource; redirectPath?: string },
): Promise<string> {
  const config = getInboxOAuthConfiguration(provider);
  const session = c.get("session");
  const teamId = c.get("teamId");
  // Integration installation is an interactive action. An unrelated API/OAuth
  // scope must not acquire mailbox credentials on behalf of its token author.
  if (!session?.user?.id || !teamId || !session.aal) {
    throw new HTTPException(403, {
      message: "Sign in to connect an inbox account",
    });
  }

  const state = randomBytes(32).toString("base64url");
  const browserNonce = randomBytes(32).toString("base64url");
  try {
    const db = c.get("db");
    const connector = new InboxConnector(provider, db);
    const url = await connector.connect(state);
    await createInboxOAuthIntent(db, {
      stateHash: digest(state),
      browserNonceHash: digest(browserNonce),
      userId: session.user.id,
      teamId,
      provider,
      source: input.source,
      aal: session.aal,
      redirectPath: input.redirectPath
        ? sanitizeRedirectPath(input.redirectPath, "/inbox")
        : undefined,
    });
    setCookie(c, config.cookieName, browserNonce, {
      ...config.cookieOptions,
      maxAge: INBOX_OAUTH_TTL_SECONDS,
    });
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    return url;
  } catch {
    // Provider exceptions can contain credential-bearing request diagnostics.
    throw new HTTPException(503, {
      message: "Unable to start inbox connection",
    });
  }
}

/**
 * No browser Authorization header is needed on the provider's GET callback.
 * Only the nonce set on the authenticated start response can claim its intent.
 */
export async function consumeInboxOAuth(
  c: InboxContext,
  provider: InboxOAuthProvider,
  state: string,
) {
  const config = getInboxOAuthConfiguration(provider);
  const nonce = getCookie(c, config.cookieName);
  if (!isInboxOAuthToken(state) || !isInboxOAuthToken(nonce)) {
    throw new HTTPException(400, {
      message: "Invalid or expired inbox connection. Please start again.",
    });
  }
  let intent: Awaited<ReturnType<typeof consumeInboxOAuthIntent>>;
  try {
    intent = await consumeInboxOAuthIntent(c.get("db"), {
      stateHash: digest(state),
      browserNonceHash: digest(nonce),
      provider,
    });
  } catch {
    throw new HTTPException(503, {
      message: "Unable to verify inbox connection",
    });
  }
  if (!intent) {
    throw new HTTPException(400, {
      message: "Invalid or expired inbox connection. Please start again.",
    });
  }
  deleteCookie(c, config.cookieName, config.cookieOptions);
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  try {
    await requireSessionMfa({ user: { id: intent.userId }, aal: intent.aal });
  } catch (error) {
    if (error instanceof MfaPolicyError) {
      throw new HTTPException(error.reason === "required" ? 403 : 503, {
        message: error.message,
      });
    }
    throw new HTTPException(503, {
      message: "Unable to verify inbox connection",
    });
  }
  return { ...intent, dashboardUrl: config.dashboardUrl };
}
