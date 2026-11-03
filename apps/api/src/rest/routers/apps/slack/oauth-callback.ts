import { publicMiddleware } from "@api/rest/middleware";
import type { Context } from "@api/rest/types";
import { consumeIntegrationOAuth, completeIntegrationOAuth } from "@api/utils/integration-oauth";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { config } from "@midday/app-store/slack";
import {
  createSlackWebClient,
  publishAppHome,
} from "@midday/app-store/slack/server";
import { bot } from "@midday/bot";
import { createApp, createOrUpdatePlatformIdentity } from "@midday/db/queries";
import { logger } from "@midday/logger";
import { HTTPException } from "hono/http-exception";
import { sendWelcomeMessage } from "./messages";

const app = new OpenAPIHono<Context>();

const paramsSchema = z.object({
  code: z.string().min(1).max(8192).optional().openapi({
    param: {
      in: "query",
      name: "code",
      required: false,
    },
    description: "OAuth authorization code from Slack",
  }),
  state: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/).openapi({
    param: {
      in: "query",
      name: "state",
      required: true,
    },
    description: "OAuth state parameter for CSRF protection",
  }),
});

const slackAuthResponseSchema = z.object({
  ok: z.literal(true),
  app_id: z.string(),
  authed_user: z.object({
    id: z.string(),
  }),
  scope: z.string(),
  token_type: z.literal("bot"),
  access_token: z.string(),
  bot_user_id: z.string(),
  team: z.object({
    id: z.string(),
    name: z.string(),
  }),
  incoming_webhook: z.object({
    channel: z.string(),
    channel_id: z.string(),
    configuration_url: z.string().url(),
    url: z.string().url(),
  }),
});

const errorResponseSchema = z.object({
  error: z.string(),
});

app.use("*", ...publicMiddleware);

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    summary: "Slack OAuth callback",
    operationId: "slackOAuthCallback",
    description:
      "Handles OAuth callback from Slack after user authorization. Exchanges authorization code for access token and creates app integration.",
    tags: ["Integrations"],
    request: {
      query: paramsSchema,
    },
    responses: {
      302: {
        description: "Redirect to dashboard completion page",
        headers: {
          Location: {
            schema: {
              type: "string",
            },
            description: "Redirect URL to dashboard",
          },
        },
      },
      400: {
        description: "Invalid request parameters",
        content: {
          "application/json": {
            schema: errorResponseSchema,
          },
        },
      },
      500: {
        description: "Failed to process OAuth callback",
        content: {
          "application/json": {
            schema: errorResponseSchema,
          },
        },
      },
    },
  }),
  async (c) => {
    const slackAdapter = bot.getAdapter("slack");
    if (!slackAdapter) {
      throw new HTTPException(503, { message: "Slack is not configured" });
    }

    const db = c.get("db");
    const query = c.req.valid("query");
    const { code, state } = query;

    const parsedState = await consumeIntegrationOAuth(c, "slack", state);
    if (!code) return c.redirect(`${parsedState.dashboardUrl}/oauth-callback?status=error&error=access_denied`, 302);

    try {
      // Exchange authorization code for access token
      const slackClientId = process.env.SLACK_CLIENT_ID;
      const slackClientSecret = process.env.SLACK_CLIENT_SECRET;
      const slackRedirectUri = process.env.SLACK_OAUTH_REDIRECT_URL;

      if (!slackClientId || !slackClientSecret || !slackRedirectUri) {
        throw new HTTPException(500, {
          message: "Slack OAuth configuration missing",
        });
      }

      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: slackClientId,
          client_secret: slackClientSecret,
          code: code,
          redirect_uri: slackRedirectUri,
        }),
      });
      const json = await response.json();

      const parsedJson = slackAuthResponseSchema.safeParse(json);

      if (!parsedJson.success) {
        throw new HTTPException(500, {
          message: "Failed to exchange code for token",
        });
      }

      // Create app integration in database
      const createdSlackIntegration = await completeIntegrationOAuth(c, parsedState, async (tx) => {
      const created = await createApp<"slack">(tx, {
        teamId: parsedState.teamId,
        createdBy: parsedState.userId,
        appId: "slack",
        settings: config.settings,
        config: {
          access_token: parsedJson.data.access_token,
          team_id: parsedJson.data.team.id,
          team_name: parsedJson.data.team.name,
          channel: parsedJson.data.incoming_webhook.channel,
          channel_id: parsedJson.data.incoming_webhook.channel_id,
          slack_configuration_url:
            parsedJson.data.incoming_webhook.configuration_url,
          url: parsedJson.data.incoming_webhook.url,
          bot_user_id: parsedJson.data.bot_user_id,
        },
      });

      await createOrUpdatePlatformIdentity(tx, {
        provider: "slack",
        teamId: parsedState.teamId,
        userId: parsedState.userId,
        externalUserId: parsedJson.data.authed_user.id,
        externalTeamId: parsedJson.data.team.id,
        metadata: {
          source: "slack_oauth_install",
        },
      });
      return created;
      });

      if (!createdSlackIntegration?.config) {
        throw new HTTPException(500, {
          message: "Failed to create app integration",
        });
      }

      await bot.initialize();
      await slackAdapter.setInstallation(parsedJson.data.team.id, {
        botToken: parsedJson.data.access_token,
        botUserId: parsedJson.data.bot_user_id,
        teamName: parsedJson.data.team.name,
      });

      const accessToken = createdSlackIntegration.config.access_token;
      const channelId = createdSlackIntegration.config.channel_id;

      // Send welcome message to Slack channel
      // This is non-blocking - OAuth flow continues even if it fails
      sendWelcomeMessage({
        channelId,
        accessToken,
        botUserId: createdSlackIntegration.config.bot_user_id,
        webhookUrl: createdSlackIntegration.config.url,
      }).catch(() => {
        // Silently handle errors - welcome message is non-critical
      });

      // Publish App Home for the installing user
      // This is non-blocking - OAuth flow continues even if it fails
      // Use Slack user ID (not Midday user ID) for views.publish
      const slackUserId = parsedJson.data.authed_user.id;
      const client = createSlackWebClient({ token: accessToken });
      publishAppHome({
        client,
        userId: slackUserId,
        db,
        teamId: parsedState.teamId,
        slackApp: {
          config: createdSlackIntegration.config,
          settings: createdSlackIntegration.settings,
        },
      }).catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        // Only log if it's not the "not_enabled" error (which is handled gracefully in publishAppHome)
        if (!errorMessage.includes("not_enabled")) {
          logger.error("Failed to publish App Home on install", {
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
            slackUserId,
            middayUserId: parsedState.userId,
            teamId: parsedState.teamId,
          });
        }
        // Silently handle errors - App Home is non-critical
      });

      // Build redirect URL to dashboard
      const dashboardUrl = parsedState.dashboardUrl;

      return c.redirect(`${dashboardUrl}/oauth-callback?status=success`, 302);
    } catch (err) {
      if (err instanceof HTTPException) {
        throw err;
      }

      logger.error("Slack OAuth callback error", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw new HTTPException(500, {
        message: "Failed to exchange code for token",
      });
    }
  },
);

export { app as oauthCallbackRouter };
