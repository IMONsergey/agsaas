import type { Context } from "@api/rest/types";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { BillingSubscriptionEventError } from "@midday/db/billing-subscription";
import { applyBillingSubscriptionEvent } from "@midday/db/queries";
import { logger } from "@midday/logger";
import { getPlans } from "@midday/plans";
import {
  validateEvent,
  WebhookVerificationError,
} from "@polar-sh/sdk/webhooks";
import { HTTPException } from "hono/http-exception";

const app = new OpenAPIHono<Context>();

const webhookResponseSchema = z.object({
  received: z.boolean(),
});

app.openapi(
  createRoute({
    method: "post",
    path: "/",
    summary: "Polar webhook handler",
    operationId: "polarWebhook",
    description:
      "Handles Polar webhook events for subscription changes. Verifies webhook signature and processes subscription events.",
    tags: ["Webhooks"],
    responses: {
      200: {
        description: "Webhook processed successfully",
        content: {
          "application/json": {
            schema: webhookResponseSchema,
          },
        },
      },
      400: {
        description: "Invalid webhook signature or payload",
      },
      500: {
        description: "Failed to process webhook event (will trigger retry)",
      },
    },
  }),
  async (c) => {
    const db = c.get("db");
    const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;

    if (!webhookSecret) {
      logger.error("POLAR_WEBHOOK_SECRET not configured");
      throw new HTTPException(500, {
        message: "Webhook secret not configured",
      });
    }

    let event: ReturnType<typeof validateEvent>;

    const rawBody = await c.req.text();
    const webhookHeaders = {
      "webhook-id": c.req.header("webhook-id") ?? "",
      "webhook-timestamp": c.req.header("webhook-timestamp") ?? "",
      "webhook-signature": c.req.header("webhook-signature") ?? "",
    };

    try {
      event = validateEvent(rawBody, webhookHeaders, webhookSecret);
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        logger.error("Polar webhook signature verification failed", {
          error: err.message,
        });
        throw new HTTPException(400, { message: "Invalid webhook signature" });
      }

      // Treat malformed/unsupported payloads as unverified. No raw-payload
      // fallback may update entitlements after a verification exception.
      throw new HTTPException(400, { message: "Invalid webhook payload" });
    }

    logger.info("Polar webhook received", {
      type: event.type,
    });

    try {
      const result = await applyBillingSubscriptionEvent(db, {
        event,
        products: Object.values(getPlans()).map((product) => ({
          id: product.id,
          plan: product.key,
        })),
      });
      logger.info("Polar subscription event processed", {
        type: event.type,
        outcome: result.state,
      });

      // Payment-issue intent commits with the entitlement transition. Existing
      // SQL notification recovery owns dispatch even when Redis is unavailable.
    } catch (err) {
      if (err instanceof BillingSubscriptionEventError) {
        throw new HTTPException(400, {
          message: "Invalid billing subscription event",
        });
      }
      logger.error("Error processing Polar webhook", {
        error: err instanceof Error ? err.message : String(err),
        eventType: event.type,
      });
      // Re-throw to return 5xx, allowing Polar to retry on transient failures.
      throw new HTTPException(500, {
        message: "Failed to process webhook event",
      });
    }

    return c.json({ received: true });
  },
);

export { app as polarWebhookRouter };
