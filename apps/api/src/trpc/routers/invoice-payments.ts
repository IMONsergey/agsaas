import { requestInvoiceRefund } from "@api/services/invoice-refund-request";
import { getInvoiceProviderReconciliationProofs } from "@api/services/invoice-provider-reconciliation";
import {
  createTRPCRouter,
  ownerProcedure,
  protectedProcedure,
} from "@api/trpc/init";
import { InvoicePaymentError } from "@midday/db/errors";
import { financialRequestHash } from "@midday/db/financial-job";
import {
  applyInvoiceProviderReconciliation,
  getInvoiceProviderReconciliationPlan,
  getInvoiceRefundContext,
  getInvoiceSettlement,
  getTeamById,
  getTeamMemberRole,
  reconcileInvoiceSettlement,
  recordInvoiceSettlement,
  requestStripeDisconnect,
} from "@midday/db/queries";
import { logger } from "@midday/logger";
import { TRPCError } from "@trpc/server";
import Stripe from "stripe";
import { z } from "zod";

async function settlementResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof InvoicePaymentError)
      throw new TRPCError({
        code:
          error.status === 403
            ? "FORBIDDEN"
            : error.status === 400
              ? "BAD_REQUEST"
              : error.status === 404
                ? "NOT_FOUND"
                : error.status === 409
                  ? "CONFLICT"
                  : "INTERNAL_SERVER_ERROR",
        message: error.message,
      });
    throw error;
  }
}

export const invoicePaymentsRouter = createTRPCRouter({
  settlement: protectedProcedure
    .input(z.object({ invoiceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const result = await settlementResult(() =>
        getInvoiceSettlement(ctx.db, { ...input, teamId: ctx.teamId! }),
      );
      return {
        ...result,
        canManage:
          (await getTeamMemberRole(
            ctx.db,
            ctx.teamId!,
            ctx.session.user.id,
          )) === "owner",
      };
    }),
  recordSettlement: ownerProcedure
    .input(
      z
        .object({
          invoiceId: z.string().uuid(),
          operationId: z.string().uuid(),
          kind: z.enum(["payment", "refund"]),
          amountMinor: z.string().regex(/^[1-9][0-9]{0,15}$/),
          currency: z.string().regex(/^[a-z]{3}$/),
          paymentId: z.string().uuid().optional(),
          occurredAt: z.string().datetime(),
          reason: z.string().trim().min(1).max(1000),
          confirmed: z.literal(true),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) =>
      settlementResult(() =>
        recordInvoiceSettlement(ctx.db, {
          invoiceId: input.invoiceId,
          teamId: ctx.teamId!,
          operationKey: financialRequestHash(
            `manual/${ctx.teamId}/${input.operationId}`,
          ),
          kind: input.kind,
          amountMinor: input.amountMinor,
          currency: input.currency,
          paymentId: input.paymentId,
          provider: "manual",
          providerAccountId: ctx.teamId!,
          providerResourceId: input.operationId,
          actorId: ctx.session.user.id,
          occurredAt: input.occurredAt,
          reason: input.reason,
        }),
      ),
    ),
  reconcileSettlement: ownerProcedure
    .input(
      z
        .object({
          invoiceId: z.string().uuid(),
          apply: z.boolean().default(false),
          verifyProvider: z.boolean().optional(),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) =>
      settlementResult(async () => {
        const scope = {
          invoiceId: input.invoiceId,
          teamId: ctx.teamId!,
          actorId: ctx.session.user.id,
        };
        if (input.verifyProvider) {
          if (!input.apply)
            throw new InvoicePaymentError(
              400,
              "Confirm provider reconciliation before applying it",
            );
          const plan = await getInvoiceProviderReconciliationPlan(
            ctx.db,
            scope,
          );
          if (!plan) return { state: "consistent" as const, changed: false };
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
            timeout: 5_000,
            maxNetworkRetries: 0,
          });
          const proofs = await getInvoiceProviderReconciliationProofs(
            stripe,
            plan,
          );
          return applyInvoiceProviderReconciliation(ctx.db, {
            ...scope,
            revision: plan.revision,
            proofs,
          });
        }
        return reconcileInvoiceSettlement(ctx.db, {
          ...scope,
          apply: input.apply,
        });
      }),
    ),

  // Get Stripe Connect status for the current team
  stripeStatus: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    if (!teamId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Team not found",
      });
    }

    const team = await getTeamById(db, teamId);

    return {
      connected: !!team?.stripeAccountId,
      status: team?.stripeConnectStatus || null,
      stripeAccountId: team?.stripeAccountId || null,
    };
  }),

  // Get Stripe Connect URL for OAuth flow
  getConnectUrl: ownerProcedure.query(async ({ ctx: { teamId } }) => {
    if (!teamId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Team not found",
      });
    }

    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe Connect is not configured",
      });
    }

    // Return the REST endpoint URL that handles the OAuth flow
    const apiUrl = process.env.MIDDAY_API_URL || "https://api.midday.ai";
    return `${apiUrl}/invoice-payments/connect-stripe`;
  }),

  // Disconnect Stripe account
  disconnectStripe: ownerProcedure.mutation(
    async ({ ctx: { db, teamId, session } }) => {
      if (!teamId)
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Team not found",
        });
      return requestStripeDisconnect(db, {
        teamId,
        actorUserId: session.user.id,
      });
    },
  ),

  refundPayment: ownerProcedure
    .input(z.object({ invoiceId: z.string().uuid() }))
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      if (!teamId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Team not found",
        });
      }

      try {
        const context = await getInvoiceRefundContext(db, {
          invoiceId: input.invoiceId,
          teamId,
        });
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
          timeout: 10_000,
          maxNetworkRetries: 0,
        });
        return await requestInvoiceRefund(context, stripe);
      } catch (err) {
        if (err instanceof InvoicePaymentError) {
          throw new TRPCError({
            code:
              err.status === 404
                ? "NOT_FOUND"
                : err.status === 400
                  ? "BAD_REQUEST"
                  : err.status === 409
                    ? "CONFLICT"
                    : "INTERNAL_SERVER_ERROR",
            message: err.message,
          });
        }
        logger.error("Failed to request invoice refund", {
          invoiceId: input.invoiceId,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to process refund",
        });
      }
    }),
});
