import { protectedMiddleware } from "@api/rest/middleware";
import type { Context } from "@api/rest/types";
import { startIntegrationOAuth } from "@api/utils/integration-oauth";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  getAccountingProvider,
} from "@midday/accounting";
import { HTTPException } from "hono/http-exception";

const app = new OpenAPIHono<Context>();

const installUrlResponseSchema = z.object({
  url: z.string().url(),
});

app.use("*", ...protectedMiddleware);

app.openapi(
  createRoute({
    method: "post",
    path: "/",
    summary: "Get Xero install URL",
    operationId: "getXeroInstallUrl",
    description:
      "Generates OAuth install URL for Xero integration. Requires authentication.",
    tags: ["Integrations"],
    responses: {
      200: {
        description: "Xero install URL",
        content: {
          "application/json": {
            schema: installUrlResponseSchema,
          },
        },
      },
      401: {
        description: "Unauthorized",
      },
      500: {
        description: "Server error",
      },
    },
  }),
  async (c) => {
    const session = c.get("session");

    if (!session?.user) {
      throw new HTTPException(401, {
        message: "Unauthorized",
      });
    }

    if (!session.teamId) {
      throw new HTTPException(401, {
        message: "Team not found",
      });
    }

    const { state } = await startIntegrationOAuth(c, "xero");

    try {
      const provider = getAccountingProvider("xero");
      const url = await provider.buildConsentUrl(state);
      return c.json({ url });
    } catch (error) {
      throw new HTTPException(500, {
        message: "Unable to start integration connection",
      });
    }
  },
);

export { app as installUrlRouter };
