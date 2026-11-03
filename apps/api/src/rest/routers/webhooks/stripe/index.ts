import type { Context } from "@api/rest/types";
import { confirmStripeRefundsForWebhook } from "@api/services/invoice-provider-reconciliation";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  applyStripeInvoicePaymentEvent,
  getTeamByStripeAccountId,
  updateTeamById,
} from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import { logger } from "@midday/logger";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

const app = new OpenAPIHono<Context>();

const webhookResponseSchema = z.object({
  received: z.boolean(),
});

const refundCandidateIdentitySchema = z.object({
  invoiceId: z.string().uuid(),
  teamId: z.string().uuid(),
  reservationId: z.string().uuid(),
});

app.openapi(
  createRoute({
    method: "post",
    path: "/",
    summary: "Stripe webhook handler",
    operationId: "stripeWebhook",
    description:
      "Handles Stripe webhook events for invoice payments. Verifies webhook signature and processes payment events.",
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
    },
  }),
  async (c) => {
    const db = c.get("db");
    const signature = c.req.header("stripe-signature");

    if (!signature) {
      throw new HTTPException(400, {
        message: "Missing stripe-signature header",
      });
    }

    const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error("STRIPE_CONNECT_WEBHOOK_SECRET not configured");
      throw new HTTPException(500, {
        message: "Webhook secret not configured",
      });
    }

    let event: Stripe.Event;

    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const rawBody = await c.req.text();

      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      logger.error("Stripe webhook signature verification failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new HTTPException(400, { message: "Invalid webhook signature" });
    }

    logger.info("Stripe webhook received", {
      type: event.type,
      id: event.id,
    });

    try {
      switch (event.type) {
        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          const invoiceId = paymentIntent.metadata?.invoice_id;
          const teamId = paymentIntent.metadata?.team_id;

          if (!invoiceId || !teamId) {
            logger.warn("Payment intent missing invoice metadata", {
              paymentIntentId: paymentIntent.id,
            });
            break;
          }

          if (
            !z.string().uuid().safeParse(invoiceId).success ||
            !z.string().uuid().safeParse(teamId).success ||
            !event.account ||
            paymentIntent.status !== "succeeded" ||
            paymentIntent.amount_received !== paymentIntent.amount
          ) {
            throw new Error(
              "Payment event does not establish a complete invoice payment",
            );
          }
          const paidAt = new Date(event.created * 1000).toISOString();
          const { invoice, notify } = await applyStripeInvoicePaymentEvent(db, {
            invoiceId,
            teamId,
            reservationId: paymentIntent.metadata.payment_reservation_id,
            paymentIntentId: paymentIntent.id,
            stripeAccountId: event.account,
            amountMinor: paymentIntent.amount_received,
            currency: paymentIntent.currency,
            kind: "paid",
            occurredAt: paidAt,
          });
          if (notify) {
            await triggerJob(
              "notification",
              {
                type: "invoice_paid",
                invoiceId,
                invoiceNumber: invoice.invoiceNumber || "",
                teamId,
                customerName: invoice.customerName || "",
                paidAt: invoice.paidAt ?? paidAt,
              },
              "notifications",
              { jobId: `stripe-event-${event.id}` },
            );
          }

          break;
        }

        case "payment_intent.payment_failed": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          const invoiceId = paymentIntent.metadata?.invoice_id;

          logger.info("Payment failed for invoice", {
            invoiceId,
            paymentIntentId: paymentIntent.id,
            error: paymentIntent.last_payment_error?.message,
          });

          // Optionally: Send notification to team about failed payment
          // await tasks.trigger("notification", { ... });

          break;
        }

        case "charge.refunded":
        case "refund.created":
        case "refund.updated":
        case "refund.failed": {
          const object = event.data.object as Stripe.Charge | Stripe.Refund;
          const paymentIntentId =
            typeof object.payment_intent === "string"
              ? object.payment_intent
              : object.payment_intent?.id;

          if (!paymentIntentId) {
            logger.warn("Refund event missing payment_intent", {
              objectId: object.id,
            });
            break;
          }

          if (
            !event.account ||
            (event.type === "charge.refunded" &&
              !(object as Stripe.Charge).paid)
          ) {
            throw new Error(
              "Refund event is missing its connected-account payment binding",
            );
          }
          // A charge's refunded flag/amount also includes asynchronous refund
          // requests. Read the complete current refund list and count succeeded
          // entries only; refund.updated can finish a previously pending refund.
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
            timeout: 5_000,
            maxNetworkRetries: 0,
          });
          const confirmation = await confirmStripeRefundsForWebhook(stripe, {
            paymentIntentId,
            stripeAccountId: event.account,
          });
          const refundedAt = new Date(event.created * 1000).toISOString();
          // A full refund can reach us before either checkout attachment or the
          // paid webhook. Fresh intent metadata can locate its reservation but
          // is not authority: the DB still checks account + exact reservation.
          // Legacy/malformed metadata is never used to select an unbound invoice;
          // that path may only find an already attached paymentIntentId.
          const candidateIdentity = refundCandidateIdentitySchema.safeParse(
            confirmation.candidateIdentity,
          );
          const { invoice, notify } = await applyStripeInvoicePaymentEvent(db, {
            ...(candidateIdentity.success ? candidateIdentity.data : {}),
            paymentIntentId,
            stripeAccountId: event.account,
            amountMinor: confirmation.amountMinor,
            refunds: confirmation.refunds,
            currency: confirmation.currency,
            kind: "refunded",
            occurredAt: refundedAt,
          });
          if (notify) {
            await triggerJob(
              "notification",
              {
                type: "invoice_refunded",
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber || "",
                teamId: invoice.teamId,
                customerName: invoice.customerName || "",
                refundedAt: invoice.refundedAt ?? refundedAt,
              },
              "notifications",
              // Multiple refund event types may confirm the same full refund.
              { jobId: `stripe-invoice-refunded-${paymentIntentId}` },
            );
          }

          break;
        }

        case "account.updated": {
          // Handle connected account status changes
          const account = event.data.object as Stripe.Account;

          logger.info("Connected account updated", {
            accountId: account.id,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
          });

          // Find the team associated with this Stripe account
          const team = await getTeamByStripeAccountId(db, account.id);

          if (team) {
            // Determine new status based on account capabilities
            let newStatus: string;
            if (account.charges_enabled && account.payouts_enabled) {
              newStatus = "connected";
            } else if (account.charges_enabled) {
              // Can accept charges but payouts restricted
              newStatus = "restricted";
            } else {
              // Cannot accept charges - payments will fail
              newStatus = "disabled";
            }

            // Only update if status changed
            if (team.stripeConnectStatus !== newStatus) {
              await updateTeamById(db, {
                id: team.id,
                data: {
                  stripeConnectStatus: newStatus,
                },
              });

              logger.info("Team Stripe status updated", {
                teamId: team.id,
                previousStatus: team.stripeConnectStatus,
                newStatus,
                accountId: account.id,
              });
            }
          } else {
            logger.warn("No team found for Stripe account", {
              accountId: account.id,
            });
          }

          break;
        }

        default:
          logger.debug("Unhandled Stripe webhook event type", {
            type: event.type,
          });
      }
    } catch {
      logger.error("Error processing Stripe webhook", {
        eventType: event.type,
        eventId: event.id,
      });
      // DB/Redis failures are not acknowledgements. Stripe must be able to retry
      // the same signed event; financial writes and queue IDs are idempotent.
      throw new HTTPException(500, {
        message: "Payment event processing is pending",
      });
    }

    return c.json({ received: true });
  },
);

export { app as stripeWebhookRouter };
