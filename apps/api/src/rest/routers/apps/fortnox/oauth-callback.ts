import { publicMiddleware } from "@api/rest/middleware";
import type { Context } from "@api/rest/types";
import { consumeIntegrationOAuth, completeIntegrationOAuth } from "@api/utils/integration-oauth";
import {
  buildErrorRedirect,
  buildSuccessRedirect,
  mapOAuthError,
} from "@api/rest/utils/oauth";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  FORTNOX_SCOPES,
  getAccountingProvider,
} from "@midday/accounting";
import config from "@midday/app-store/fortnox";
import { createApp } from "@midday/db/queries";
import { logger } from "@midday/logger";

const app = new OpenAPIHono<Context>();

const paramsSchema = z.object({
  code: z
    .string().min(1).max(8192)
    .optional()
    .openapi({
      param: {
        in: "query",
        name: "code",
        required: false,
      },
      description: "OAuth authorization code from Fortnox",
    }),
  state: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/).openapi({
    param: {
      in: "query",
      name: "state",
      required: true,
    },
    description: "OAuth state parameter for CSRF protection",
  }),
  error: z
    .string().min(1).max(8192)
    .optional()
    .openapi({
      param: {
        in: "query",
        name: "error",
        required: false,
      },
      description: "OAuth error code if authorization failed",
    }),
});

app.use("*", ...publicMiddleware);

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    summary: "Fortnox OAuth callback",
    operationId: "fortnoxOAuthCallback",
    description:
      "Handles OAuth callback from Fortnox after user authorization. Exchanges authorization code for access token and creates app integration.",
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
      },
    },
  }),
  async (c) => {
    const query = c.req.valid("query");
    const { code, state, error } = query;
    const parsedState = await consumeIntegrationOAuth(c, "fortnox", state);
    const { dashboardUrl, source } = parsedState;

    // Handle OAuth errors (user denied access, etc.)
    if (error || !code) {
      const errorCode = mapOAuthError(error);
      logger.info("Fortnox OAuth error or cancelled", { error, errorCode });
      return c.redirect(
        buildErrorRedirect(dashboardUrl, errorCode, "fortnox", source),
        302,
      );
    }

    try {
      const provider = getAccountingProvider("fortnox");

      // Exchange code for tokens (this also stores tokens in the provider instance)
      const tokenSet = await provider.exchangeCodeForTokens(code);

      // Fortnox is single-tenant, get the company info
      // The provider already has the tokens from exchangeCodeForTokens
      const companyInfo = await provider.getTenantInfo("default");

      // Create app integration in database
      await completeIntegrationOAuth(c, parsedState, (tx) => createApp<"fortnox">(tx, {
        teamId: parsedState.teamId,
        createdBy: parsedState.userId,
        appId: "fortnox",
        settings: config.settings,
        config: {
          provider: "fortnox",
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          expiresAt: tokenSet.expiresAt.toISOString(),
          companyId: companyInfo.id,
          companyName: companyInfo.name,
          scope: FORTNOX_SCOPES as string[],
        },
      }));

      logger.info("Fortnox integration created successfully", {
        teamId: parsedState.teamId,
        companyId: companyInfo.id,
        companyName: companyInfo.name,
      });

      // Redirect based on source
      return c.redirect(
        buildSuccessRedirect(dashboardUrl, "fortnox", parsedState.source),
        302,
      );
    } catch (err) {
      logger.error("Fortnox OAuth callback error", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      return c.redirect(
        buildErrorRedirect(
          dashboardUrl,
          "token_exchange_failed",
          "fortnox",
          parsedState.source,
        ),
        302,
      );
    }
  },
);

export { app as oauthCallbackRouter };
