import {
  deleteCustomerSchema,
  enrichCustomerSchema,
  getCustomerByIdSchema,
  getCustomerByPortalIdSchema,
  getCustomerInvoiceSummarySchema,
  getCustomersSchema,
  getPortalInvoicesSchema,
  toggleCustomerPortalSchema,
  upsertCustomerSchema,
} from "@api/schemas/customers";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@api/trpc/init";
import {
  cancelCustomerEnrichment,
  clearCustomerEnrichment,
  deleteCustomer,
  getCustomerById,
  getCustomerByPortalId,
  getCustomerInvoiceSummary,
  getCustomerPortalInvoices,
  getCustomers,
  requestCustomerEnrichment,
  toggleCustomerPortal,
  upsertCustomer,
} from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import { createLoggerWithContext } from "@midday/logger";
import { TRPCError } from "@trpc/server";

const logger = createLoggerWithContext("trpc:customers");

async function startEnrichment(
  db: Parameters<typeof requestCustomerEnrichment>[0],
  identity: { customerId: string; teamId: string },
) {
  const operation = await requestCustomerEnrichment(db, identity);
  if (!operation)
    throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
  try {
    await triggerJob(
      "enrich-customer",
      { ...identity, operationId: operation.operationId },
      "customers",
      {
        jobId: `enrich-${operation.operationId}-${operation.attemptCount}`,
        attempts: 1,
      },
    );
  } catch {
    logger.warn("Customer enrichment intent awaits queue reconciliation", {
      operationId: operation.operationId,
    });
  }
  return { queued: true, operationId: operation.operationId };
}

export const customersRouter = createTRPCRouter({
  get: protectedProcedure
    .input(getCustomersSchema.optional())
    .query(async ({ ctx: { teamId, db }, input }) => {
      return getCustomers(db, {
        teamId: teamId!,
        ...input,
      });
    }),

  getById: protectedProcedure
    .input(getCustomerByIdSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getCustomerById(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  delete: protectedProcedure
    .input(deleteCustomerSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return deleteCustomer(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  upsert: protectedProcedure
    .input(upsertCustomerSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      const isNewCustomer = !input.id;

      const customer = await upsertCustomer(db, {
        ...input,
        teamId: teamId!,
        userId: session.user.id,
      });

      if (
        isNewCustomer &&
        process.env.COMPANY_ENRICH_API_KEY?.trim() &&
        (customer?.website || customer?.email) &&
        customer?.id
      ) {
        try {
          await startEnrichment(db, {
            customerId: customer.id,
            teamId: teamId!,
          });
        } catch {
          logger.warn("Automatic customer enrichment was not accepted");
        }
      }

      return customer;
    }),

  getInvoiceSummary: protectedProcedure
    .input(getCustomerInvoiceSummarySchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getCustomerInvoiceSummary(db, {
        customerId: input.id,
        teamId: teamId!,
      });
    }),

  enrich: protectedProcedure
    .input(enrichCustomerSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      if (!process.env.COMPANY_ENRICH_API_KEY?.trim())
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Customer enrichment is not configured for this installation",
        });
      const customer = await getCustomerById(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!customer) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Customer not found",
        });
      }

      if (!customer.website && !customer.email) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Customer has no website or email - enrichment requires at least one",
        });
      }

      return startEnrichment(db, { customerId: customer.id, teamId: teamId! });
    }),

  cancelEnrichment: protectedProcedure
    .input(enrichCustomerSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const customer = await getCustomerById(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!customer) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Customer not found",
        });
      }

      const cancelled = await cancelCustomerEnrichment(db, {
        customerId: customer.id,
        teamId: teamId!,
      });
      return { cancelled };
    }),

  clearEnrichment: protectedProcedure
    .input(enrichCustomerSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const customer = await getCustomerById(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!customer) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Customer not found",
        });
      }

      await db.transaction(async (tx) => {
        await cancelCustomerEnrichment(tx, {
          customerId: customer.id,
          teamId: teamId!,
        });
        await clearCustomerEnrichment(tx, {
          customerId: customer.id,
          teamId: teamId!,
        });
      });

      return { cleared: true };
    }),

  togglePortal: protectedProcedure
    .input(toggleCustomerPortalSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return toggleCustomerPortal(db, {
        customerId: input.customerId,
        teamId: teamId!,
        enabled: input.enabled,
      });
    }),

  getByPortalId: publicProcedure
    .input(getCustomerByPortalIdSchema)
    .query(async ({ ctx: { db }, input }) => {
      const customer = await getCustomerByPortalId(db, {
        portalId: input.portalId,
      });

      if (!customer) {
        return null;
      }

      // Get invoice summary
      const summary = await getCustomerInvoiceSummary(db, {
        customerId: customer.id,
        teamId: customer.teamId,
      });

      return {
        customer,
        summary,
      };
    }),

  getPortalInvoices: publicProcedure
    .input(getPortalInvoicesSchema)
    .query(async ({ ctx: { db }, input }) => {
      const customer = await getCustomerByPortalId(db, {
        portalId: input.portalId,
      });

      if (!customer) {
        return { data: [], meta: { cursor: null } };
      }

      const result = await getCustomerPortalInvoices(db, {
        customerId: customer.id,
        teamId: customer.teamId,
        cursor: input.cursor,
        pageSize: input.pageSize,
      });

      return {
        data: result.data,
        meta: {
          cursor: result.nextCursor,
        },
      };
    }),
});
