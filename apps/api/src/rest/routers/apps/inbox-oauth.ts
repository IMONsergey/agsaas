import { protectedMiddleware, publicMiddleware } from "@api/rest/middleware";
import type { Context } from "@api/rest/types";
import {
  buildErrorRedirect,
  buildSuccessRedirect,
  mapOAuthError,
} from "@api/rest/utils/oauth";
import { consumeInboxOAuth, startInboxOAuth } from "@api/utils/inbox-oauth";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { InboxConnector } from "@midday/inbox/connector";
import type { InboxOAuthProvider } from "@midday/inbox/utils";
import { triggerJob } from "@midday/job-client";
import { logger } from "@midday/logger";

export function createInboxInstallUrlRouter(provider: InboxOAuthProvider) {
  const app = new OpenAPIHono<Context>();
  app.use("*", ...protectedMiddleware);
  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      summary: `Start ${provider} inbox connection`,
      operationId: `start${provider === "gmail" ? "Gmail" : "Outlook"}InboxConnection`,
      description:
        "Creates a short-lived browser-bound OAuth intent. Requires a signed-in user and credentialed browser request; API keys and OAuth access tokens cannot install an inbox.",
      tags: ["Integrations"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                source: z.enum(["inbox", "apps"]).default("apps"),
                redirectPath: z.string().max(2048).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description:
            "Provider authorization URL; the response also sets the callback nonce cookie",
          content: {
            "application/json": { schema: z.object({ url: z.string().url() }) },
          },
        },
        401: { description: "Unauthorized" },
        403: {
          description: "A signed-in user with current access is required",
        },
        503: { description: "Inbox connection unavailable" },
      },
    }),
    async (c) => {
      const url = await startInboxOAuth(c, provider, c.req.valid("json"));
      return c.json({ url });
    },
  );
  return app;
}

export function createInboxOAuthCallbackRouter(provider: InboxOAuthProvider) {
  const app = new OpenAPIHono<Context>();
  app.use("*", ...publicMiddleware);
  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      summary: `${provider} OAuth callback`,
      operationId: `${provider}OAuthCallback`,
      description:
        "Consumes a browser-bound intent, rechecks actor authorization, and exchanges the provider code once.",
      tags: ["Integrations"],
      request: {
        query: z.object({
          code: z.string().min(1).max(8192).optional(),
          state: z
            .string()
            .length(43)
            .regex(/^[A-Za-z0-9_-]+$/),
          error: z.string().max(1024).optional(),
        }),
      },
      responses: {
        302: {
          description: "Redirect to the configured dashboard",
          headers: {
            Location: {
              schema: { type: "string" },
              description: "Dashboard result URL",
            },
          },
        },
        400: { description: "Invalid, expired, or already used connection" },
        403: { description: "Additional authentication required" },
        503: { description: "Inbox connection unavailable" },
      },
    }),
    async (c) => {
      const { code, state, error } = c.req.valid("query");
      // Also consume cancellations. They must never trust an unbound state to
      // choose the team, actor, popup source or return path.
      const intent = await consumeInboxOAuth(c, provider, state);
      const redirectPath = intent.redirectPath ?? undefined;
      if (error || !code) {
        return c.redirect(
          buildErrorRedirect(
            intent.dashboardUrl,
            mapOAuthError(error),
            provider,
            intent.source,
            "/inbox",
            redirectPath,
          ),
          302,
        );
      }
      try {
        const connector = new InboxConnector(provider, c.get("db"));
        const account = await connector.exchangeCodeForAccount({
          code,
          teamId: intent.teamId,
          actorUserId: intent.userId,
        });
        if (!account) throw new Error("Inbox account was not saved");
        await triggerJob(
          "initial-setup",
          { inboxAccountId: account.id, teamId: intent.teamId },
          "inbox-provider",
        );
        return c.redirect(
          buildSuccessRedirect(
            intent.dashboardUrl,
            provider,
            intent.source,
            "/inbox",
            redirectPath,
          ),
          302,
        );
      } catch {
        // Do not log provider errors, authorization codes, state or cookies.
        logger.error("Inbox OAuth connection failed", { provider });
        return c.redirect(
          buildErrorRedirect(
            intent.dashboardUrl,
            "token_exchange_failed",
            provider,
            intent.source,
            "/inbox",
            redirectPath,
          ),
          302,
        );
      }
    },
  );
  return app;
}
