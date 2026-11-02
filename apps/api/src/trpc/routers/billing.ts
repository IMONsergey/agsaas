import {
  cancelSubscriptionSchema,
  createCheckoutSchema,
  getBillingOrdersSchema,
} from "@api/schemas/billing";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { getInstanceCapabilities } from "@api/utils/instance-capabilities";
import { api } from "@api/utils/polar";
import {
  getTeamById,
  getTeamMemberRole,
  updateTeamById,
} from "@midday/db/queries";
import { createLoggerWithContext } from "@midday/logger";
import { getPlanIntervalByProductId, getPlanProductId } from "@midday/plans";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

const logger = createLoggerWithContext("trpc:billing");

function requireBilling() {
  if (!getInstanceCapabilities().billing.enabled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Subscriptions are not configured for this installation.",
    });
  }
}

const billingOwnerProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const db = ctx.db.usePrimaryOnly ? ctx.db.usePrimaryOnly() : ctx.db;
  if (
    (await getTeamMemberRole(db, ctx.teamId!, ctx.session.user.id)) !== "owner"
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only a team owner can manage subscriptions.",
    });
  }
  requireBilling();
  return next();
});

async function resolvePolarCustomer(
  _db: Parameters<typeof getTeamById>[0],
  teamId: string,
): Promise<{ id: string }> {
  requireBilling();
  // Email addresses can be shared across teams. Only the team's immutable
  // external customer ID is sufficient for billing portal authorization.
  return api.customers.getExternal({ externalId: teamId });
}

export const billingRouter = createTRPCRouter({
  createCheckout: billingOwnerProcedure
    .input(createCheckoutSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const dashboardUrl =
        process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_URL;
      if (!dashboardUrl)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The workspace address is not configured.",
        });
      const origin = new URL(dashboardUrl).origin;
      if (new URL(input.embedOrigin).origin !== origin)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid checkout origin.",
        });
      const yearly =
        input.planType === "yearly" ||
        input.planType === "year" ||
        input.planType?.endsWith("_yearly") === true;
      const productId = getPlanProductId(input.plan, yearly);
      const primary = db.usePrimaryOnly ? db.usePrimaryOnly() : db;
      const team = await getTeamById(primary, teamId!);
      if (!team)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found.",
        });
      if (
        team.plan !== "trial" ||
        ["active", "trialing", "past_due"].includes(
          team.subscriptionStatus ?? "",
        )
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Manage your existing subscription in the billing portal.",
        });
      }
      const checkout = await api.checkouts.create({
        products: [productId],
        externalCustomerId: teamId!,
        customerName: team?.name ?? undefined,
        customerEmail: session.user.email,
        metadata: { teamId: teamId! },
        customerMetadata: { teamId: teamId! },
        successUrl: `${origin}/settings/billing?checkout=complete`,
        returnUrl: `${origin}/settings/billing`,
        embedOrigin: origin,
        allowTrial: false,
      });
      return { url: checkout.url };
    }),

  orders: protectedProcedure
    .input(getBillingOrdersSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      try {
        const customer = await resolvePolarCustomer(db, teamId!);

        const ordersResult = await api.orders.list({
          customerId: customer.id,
          page: input.cursor ? Number(input.cursor) : 1,
          limit: input.pageSize,
        });

        const orders = ordersResult.result.items;
        const pagination = ordersResult.result.pagination;

        // Filter orders to only include those where metadata.teamId matches teamId
        const filteredOrders = orders.filter((order) => {
          const organizationId = order.metadata?.teamId;
          return organizationId === teamId;
        });

        return {
          data: filteredOrders.map((order) => ({
            id: order.id,
            createdAt: order.createdAt,
            amount: {
              amount: order.totalAmount,
              currency: order.currency,
            },
            status: order.status,
            product: {
              name: order.product?.name || "Subscription",
            },
            invoiceId: order.isInvoiceGenerated ? order.id : null,
          })),
          meta: {
            hasNextPage:
              (input.cursor ? Number(input.cursor) : 1) < pagination.maxPage,
            cursor:
              (input.cursor ? Number(input.cursor) : 1) < pagination.maxPage
                ? ((input.cursor ? Number(input.cursor) : 1) + 1).toString()
                : undefined,
          },
        };
      } catch {
        return {
          data: [],
          meta: {
            hasNextPage: false,
            cursor: undefined,
          },
        };
      }
    }),

  getInvoice: billingOwnerProcedure
    .input(z.string())
    .mutation(async ({ input: orderId, ctx: { teamId } }) => {
      try {
        const order = await api.orders.get({
          id: orderId,
        });

        // Verify the order belongs to this team
        if (order.metadata?.teamId !== teamId) {
          throw new Error("Order not found or not authorized");
        }

        // If invoice doesn't exist, generate it
        if (!order.isInvoiceGenerated) {
          await api.orders.generateInvoice({
            id: orderId,
          });

          // Return status indicating generation is in progress
          return {
            status: "generating",
          };
        }

        // Try to get the invoice
        try {
          const invoice = await api.orders.invoice({
            id: orderId,
          });

          return {
            status: "ready",
            downloadUrl: invoice.url,
          };
        } catch (_invoiceError) {
          // Invoice might still be generating
          return {
            status: "generating",
          };
        }
      } catch (error) {
        logger.error("Failed to get invoice download URL", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          error instanceof Error ? error.message : "Failed to download invoice",
        );
      }
    }),

  checkInvoiceStatus: protectedProcedure
    .input(z.string())
    .query(async ({ input: orderId, ctx: { teamId } }) => {
      try {
        const order = await api.orders.get({
          id: orderId,
        });

        // Verify the order belongs to this team
        if (order.metadata?.teamId !== teamId) {
          throw new Error("Order not found or not authorized");
        }

        if (!order.isInvoiceGenerated) {
          return {
            status: "not_generated",
          };
        }

        try {
          const invoice = await api.orders.invoice({
            id: orderId,
          });

          return {
            status: "ready",
            downloadUrl: invoice.url,
          };
        } catch (_invoiceError) {
          return {
            status: "generating",
          };
        }
      } catch (error) {
        logger.error("Failed to check invoice status", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          error instanceof Error
            ? error.message
            : "Failed to check invoice status",
        );
      }
    }),

  getActiveSubscription: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      try {
        const customer = await resolvePolarCustomer(db, teamId!);
        const subscriptions = await api.subscriptions.list({
          customerId: customer.id,
        });

        const active = subscriptions.result.items.find(
          (s) =>
            s.metadata?.teamId === teamId &&
            (s.status === "active" ||
              s.status === "past_due" ||
              s.status === "trialing"),
        );

        if (!active) {
          return null;
        }

        const interval = getPlanIntervalByProductId(active.productId);

        return { isYearly: interval === "year" };
      } catch {
        return null;
      }
    },
  ),

  getPortalUrl: billingOwnerProcedure.mutation(
    async ({ ctx: { db, teamId } }) => {
      const customer = await resolvePolarCustomer(db, teamId!);
      const result = await api.customerSessions.create({
        customerId: customer.id,
      });

      return { url: result.customerPortalUrl };
    },
  ),

  cancelSubscription: billingOwnerProcedure
    .input(cancelSubscriptionSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const customer = await resolvePolarCustomer(db, teamId!);
      const subscriptions = await api.subscriptions.list({
        customerId: customer.id,
      });

      const teamSubs = subscriptions.result.items.filter(
        (s) => s.metadata?.teamId === teamId,
      );

      const activeSubscription = teamSubs.find(
        (s) =>
          s.status === "active" ||
          s.status === "past_due" ||
          s.status === "trialing",
      );

      if (!activeSubscription) {
        const alreadyCanceled = teamSubs.some(
          (s) => s.status === "canceled" || s.cancelAtPeriodEnd,
        );

        if (alreadyCanceled) {
          logger.info("Subscription already canceled", { teamId });
          return { success: true };
        }

        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No active subscription found",
        });
      }

      if (activeSubscription.cancelAtPeriodEnd) {
        logger.info("Subscription already scheduled for cancellation", {
          teamId,
        });

        return {
          success: true,
        };
      }

      await api.subscriptions.update({
        id: activeSubscription.id,
        subscriptionUpdate: {
          cancelAtPeriodEnd: true,
          customerCancellationReason: input.reason,
          customerCancellationComment: input.comment,
        },
      });

      await updateTeamById(db, {
        id: teamId!,
        data: { canceledAt: new Date().toISOString() },
      });

      logger.info("Subscription canceled", {
        teamId,
        reason: input.reason,
      });

      return { success: true };
    }),

  reactivateSubscription: billingOwnerProcedure.mutation(
    async ({ ctx: { db, teamId } }) => {
      const customer = await resolvePolarCustomer(db, teamId!);
      const subscriptions = await api.subscriptions.list({
        customerId: customer.id,
      });

      const subscription = subscriptions.result.items.find(
        (s) =>
          s.metadata?.teamId === teamId &&
          (s.status === "active" ||
            s.status === "past_due" ||
            s.status === "trialing") &&
          s.cancelAtPeriodEnd,
      );

      if (!subscription) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No canceled subscription found to reactivate",
        });
      }

      await api.subscriptions.update({
        id: subscription.id,
        subscriptionUpdate: {
          cancelAtPeriodEnd: false,
        },
      });

      await updateTeamById(db, {
        id: teamId!,
        data: { canceledAt: null },
      });

      logger.info("Subscription reactivated", { teamId });

      return { success: true };
    },
  ),
});
