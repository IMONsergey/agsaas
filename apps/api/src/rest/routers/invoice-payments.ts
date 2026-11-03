import { protectedMiddleware, publicMiddleware } from "@api/rest/middleware";
import type { Context } from "@api/rest/types";
import { prepareInvoicePaymentSession } from "@api/services/invoice-payment-session";
import {
  completeIntegrationOAuth,
  consumeIntegrationOAuth,
  startIntegrationOAuth,
} from "@api/utils/integration-oauth";
import {
  requireTeamOwner,
  TeamOwnerRequiredError,
} from "@api/utils/team-owner";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { InvoicePaymentError } from "@midday/db/errors";
import {
  assertNoPendingProviderCleanup,
  attachInvoicePayment,
  getTeamById,
  requestStripeDisconnect,
  requireInvoicePaymentReconciliation,
  reserveInvoicePayment,
  updateTeamById,
} from "@midday/db/queries";
import { verify as verifyInvoiceToken } from "@midday/invoice/token";
import { logger } from "@midday/logger";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

const app = new OpenAPIHono<Context>();

// ============================================================================
// Connect Stripe Endpoint
// ============================================================================

const connectStripeResponseSchema = z.object({
  url: z.string().url(),
});

app.use("/connect-stripe", ...protectedMiddleware);

app.openapi(
  createRoute({
    method: "post",
    path: "/connect-stripe",
    summary: "Get Stripe Connect URL",
    operationId: "getStripeConnectUrl",
    description:
      "Generates OAuth URL for Stripe Connect Standard integration. Allows teams to connect their Stripe account for accepting invoice payments.",
    tags: ["Invoice Payments"],
    responses: {
      200: {
        description: "Stripe Connect OAuth URL",
        content: {
          "application/json": {
            schema: connectStripeResponseSchema,
          },
        },
      },
      401: {
        description: "Unauthorized",
      },
      500: {
        description: "Server error - Stripe configuration missing",
      },
    },
  }),
  async (c) => {
    const session = c.get("session");

    if (!session?.user) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }

    if (!session.teamId) {
      throw new HTTPException(401, { message: "Team not found" });
    }

    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) {
      throw new HTTPException(500, {
        message: "Stripe Connect is not configured",
      });
    }

    const { state, redirectUri } = await startIntegrationOAuth(c, "stripe");

    // Build Stripe Connect OAuth URL (Standard accounts)
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: "read_write",
      redirect_uri: redirectUri,
      state,
    });

    const url = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;

    return c.json({ url });
  },
);

// ============================================================================
// OAuth Callback Endpoint
// ============================================================================

const callbackParamsSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(8192)
    .optional()
    .openapi({
      param: { in: "query", name: "code", required: false },
      description: "OAuth authorization code from Stripe",
    }),
  state: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/)
    .openapi({
      param: { in: "query", name: "state", required: true },
      description: "OAuth state parameter for CSRF protection",
    }),
  error: z
    .string()
    .min(1)
    .max(8192)
    .optional()
    .openapi({
      param: { in: "query", name: "error", required: false },
      description: "OAuth error code if authorization failed",
    }),
  error_description: z
    .string()
    .min(1)
    .max(8192)
    .optional()
    .openapi({
      param: { in: "query", name: "error_description", required: false },
      description: "OAuth error description",
    }),
});

app.use("/connect-stripe/callback", ...publicMiddleware);

app.openapi(
  createRoute({
    method: "get",
    path: "/connect-stripe/callback",
    summary: "Stripe Connect OAuth callback",
    operationId: "stripeConnectCallback",
    description:
      "Handles OAuth callback from Stripe Connect after user authorization. Exchanges authorization code for connected account ID.",
    tags: ["Invoice Payments"],
    request: {
      query: callbackParamsSchema,
    },
    responses: {
      302: {
        description: "Redirect to dashboard",
        headers: {
          Location: {
            schema: { type: "string" },
            description: "Redirect URL",
          },
        },
      },
      400: {
        description: "Invalid request parameters",
      },
    },
  }),
  async (c) => {
    const { code, state, error, error_description } = c.req.valid("query");
    const parsedState = await consumeIntegrationOAuth(c, "stripe", state);
    const { dashboardUrl } = parsedState;

    // Handle OAuth errors
    if (error || !code) {
      logger.info("Stripe Connect OAuth error or cancelled", {
        error,
        error_description,
      });
      return c.redirect(
        `${dashboardUrl}/invoices?stripe_connect=error&message=${encodeURIComponent(error_description || error || "Connection cancelled")}`,
        302,
      );
    }

    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
        timeout: 15_000,
        maxNetworkRetries: 0,
      });

      // Exchange authorization code for connected account ID
      const response = await stripe.oauth.token({
        grant_type: "authorization_code",
        code,
      });

      const stripeAccountId = response.stripe_user_id;

      if (!stripeAccountId) {
        throw new Error("No stripe_user_id in response");
      }

      // Get account details to check status
      const account = await stripe.accounts.retrieve(stripeAccountId);

      // Determine connect status based on account capabilities
      let connectStatus = "connected";
      if (!account.charges_enabled || !account.payouts_enabled) {
        connectStatus = "restricted";
      }

      // Update team with Stripe account info
      await completeIntegrationOAuth(c, parsedState, async (tx) => {
        await assertNoPendingProviderCleanup(
          tx,
          parsedState.teamId,
          "stripe",
          stripeAccountId,
        );
        return updateTeamById(tx, {
          id: parsedState.teamId,
          data: { stripeAccountId, stripeConnectStatus: connectStatus },
        });
      });

      logger.info("Stripe Connect integration created", {
        teamId: parsedState.teamId,
        stripeAccountId,
        connectStatus,
      });

      // Redirect to success page
      return c.redirect(`${dashboardUrl}/oauth-callback?status=success`, 302);
    } catch (err) {
      logger.error("Stripe Connect OAuth callback error", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      return c.redirect(
        `${dashboardUrl}/invoices?stripe_connect=error&message=${encodeURIComponent("Failed to connect Stripe account")}`,
        302,
      );
    }
  },
);

// ============================================================================
// Disconnect Stripe Endpoint
// ============================================================================

app.use("/disconnect-stripe", ...protectedMiddleware);

app.openapi(
  createRoute({
    method: "post",
    path: "/disconnect-stripe",
    summary: "Disconnect Stripe account",
    operationId: "disconnectStripe",
    description: "Disconnects the team's Stripe Connect account.",
    tags: ["Invoice Payments"],
    responses: {
      200: {
        description: "Successfully disconnected",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              cleanupPending: z.boolean(),
              cleanupId: z.string().uuid().nullable(),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
      },
    },
  }),
  async (c) => {
    const db = c.get("db");
    const session = c.get("session");

    if (!session?.user || !session.teamId) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }

    if (c.get("authType") !== "session")
      throw new HTTPException(403, {
        message: "Sign in as a team owner to manage payment connections",
      });

    try {
      await requireTeamOwner(db, session.teamId, session.user.id);
    } catch (error) {
      if (error instanceof TeamOwnerRequiredError)
        throw new HTTPException(403, { message: error.message });
      throw error;
    }

    if (c.get("authType") !== "session")
      throw new HTTPException(403, {
        message: "An interactive owner session is required",
      });
    return c.json(
      await requestStripeDisconnect(db, {
        teamId: session.teamId,
        actorUserId: session.user.id,
      }),
    );
  },
);

// ============================================================================
// Create Payment Intent Endpoint (Public - for invoice customers)
// ============================================================================

const createPaymentIntentSchema = z.object({
  token: z.string().openapi({
    description: "Invoice token for authentication",
  }),
});

const paymentIntentResponseSchema = z.object({
  clientSecret: z.string(),
  amount: z.number(),
  currency: z.string(),
  stripeAccountId: z.string(),
});

app.use("/payment-intent", ...publicMiddleware);

app.openapi(
  createRoute({
    method: "post",
    path: "/payment-intent",
    summary: "Create payment intent for invoice",
    operationId: "createInvoicePaymentIntent",
    description:
      "Creates a Stripe PaymentIntent for paying an invoice. This is a public endpoint that uses the invoice token for authentication.",
    tags: ["Invoice Payments"],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: createPaymentIntentSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Payment intent created",
        content: {
          "application/json": {
            schema: paymentIntentResponseSchema,
          },
        },
      },
      400: {
        description: "Invalid request or invoice not payable",
      },
      404: {
        description: "Invoice not found",
      },
      409: {
        description: "Existing payment needs confirmation or reconciliation",
      },
      503: {
        description:
          "Provider or persistence outcome is uncertain; no new intent is created",
      },
    },
  }),
  async (c) => {
    const db = c.get("db");
    const { token } = c.req.valid("json");

    // Verify token and get invoice ID
    let invoiceId: string;
    try {
      const { id } = (await verifyInvoiceToken(decodeURIComponent(token))) as {
        id: string;
      };
      if (!z.string().uuid().safeParse(id).success) {
        throw new Error("Invalid token");
      }
      invoiceId = id;
    } catch {
      throw new HTTPException(400, { message: "Invalid invoice token" });
    }

    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
        timeout: 10_000,
        maxNetworkRetries: 0,
      });
      const session = await prepareInvoicePaymentSession(
        {
          reserve: () => reserveInvoicePayment(db, { invoiceId }),
          attach: (reservation, paymentIntentId) =>
            attachInvoicePayment(db, { ...reservation, paymentIntentId }),
          reconcile: (reservation, reason, paymentIntentId) =>
            requireInvoicePaymentReconciliation(
              db,
              reservation,
              reason,
              paymentIntentId,
            ),
        },
        stripe,
      );
      return c.json(session);
    } catch (err) {
      if (err instanceof InvoicePaymentError) {
        throw new HTTPException(err.status, { message: err.message });
      }
      // Do not log provider payloads or client secrets on an unexpected error.
      logger.error("Failed to prepare invoice payment session", { invoiceId });
      throw new HTTPException(500, {
        message: "Failed to create payment session",
      });
    }
  },
);

// ============================================================================
// Get Stripe Connect Status Endpoint
// ============================================================================

const stripeStatusResponseSchema = z.object({
  connected: z.boolean(),
  status: z.string().nullable(),
  stripeAccountId: z.string().nullable(),
});

app.use("/stripe-status", ...protectedMiddleware);

app.openapi(
  createRoute({
    method: "get",
    path: "/stripe-status",
    summary: "Get Stripe Connect status",
    operationId: "getStripeConnectStatus",
    description: "Gets the current Stripe Connect status for the team.",
    tags: ["Invoice Payments"],
    responses: {
      200: {
        description: "Stripe Connect status",
        content: {
          "application/json": {
            schema: stripeStatusResponseSchema,
          },
        },
      },
      401: {
        description: "Unauthorized",
      },
    },
  }),
  async (c) => {
    const db = c.get("db");
    const session = c.get("session");

    if (!session?.user || !session.teamId) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }

    const team = await getTeamById(db, session.teamId);

    return c.json({
      connected: !!team?.stripeAccountId,
      status: team?.stripeConnectStatus || null,
      stripeAccountId: team?.stripeAccountId || null,
    });
  },
);

export { app as invoicePaymentsRouter };
