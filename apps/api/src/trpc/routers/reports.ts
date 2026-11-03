import {
  createReportSchema,
  listSharedReportsSchema,
  revokeSharedReportSchema,
  getAccountBalancesSchema,
  getBurnRateSchema,
  getChartDataByLinkIdSchema,
  getExpensesSchema,
  getProfitSchema,
  getReportByLinkIdSchema,
  getRevenueForecastSchema,
  getRevenueSchema,
  getRunwaySchema,
  getSpendingSchema,
  getTaxSummarySchema,
} from "@api/schemas/reports";
import {
  createTRPCRouter,
  protectedProcedure,
  ownerProcedure,
  publicProcedure,
} from "@api/trpc/init";
import {
  InvalidReportTypeError,
  ReportExpiredError,
  ReportNotFoundError,
} from "@midday/db/errors";
import {
  createReport,
  listSharedReports,
  revokeSharedReport,
  getBurnRate,
  getCashBalance,
  getChartDataByLinkId,
  getExpenses,
  getReportByLinkId,
  getReports,
  getRevenueForecast,
  getRunway,
  getSpending,
  getTaxSummary,
} from "@midday/db/queries";
import { TRPCError } from "@trpc/server";

export const reportsRouter = createTRPCRouter({
  revenue: protectedProcedure
    .input(getRevenueSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getReports(db, {
        teamId: teamId!,
        from: input.from,
        to: input.to,
        currency: input.currency,
        type: "revenue",
        revenueType: input.revenueType,
      });
    }),

  profit: protectedProcedure
    .input(getProfitSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getReports(db, {
        teamId: teamId!,
        from: input.from,
        to: input.to,
        currency: input.currency,
        type: "profit",
        revenueType: input.revenueType,
      });
    }),

  burnRate: protectedProcedure
    .input(getBurnRateSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getBurnRate(db, {
        teamId: teamId!,
        from: input.from,
        to: input.to,
        currency: input.currency,
      });
    }),

  runway: protectedProcedure
    .input(getRunwaySchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getRunway(db, {
        teamId: teamId!,
        currency: input.currency,
      });
    }),

  expense: protectedProcedure
    .input(getExpensesSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getExpenses(db, {
        teamId: teamId!,
        from: input.from,
        to: input.to,
        currency: input.currency,
      });
    }),

  spending: protectedProcedure
    .input(getSpendingSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getSpending(db, {
        teamId: teamId!,
        from: input.from,
        to: input.to,
        currency: input.currency,
      });
    }),

  taxSummary: protectedProcedure
    .input(getTaxSummarySchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getTaxSummary(db, {
        teamId: teamId!,
        from: input.from,
        to: input.to,
        currency: input.currency,
        type: input.type,
        categorySlug: input.categorySlug,
        taxType: input.taxType,
      });
    }),

  revenueForecast: protectedProcedure
    .input(getRevenueForecastSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getRevenueForecast(db, {
        teamId: teamId!,
        from: input.from,
        to: input.to,
        forecastMonths: input.forecastMonths,
        currency: input.currency,
        revenueType: input.revenueType,
      });
    }),

  getAccountBalances: protectedProcedure
    .input(getAccountBalancesSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const accountBalances = await getCashBalance(db, {
        teamId: teamId!,
        currency: input.currency,
      });

      return {
        result: accountBalances,
      };
    }),

  create: ownerProcedure
    .input(createReportSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      const result = await createReport(db, {
        type: input.type,
        from: input.from,
        to: input.to,
        currency: input.currency,
        teamId: teamId!,
        createdBy: session.user.id,
        expireAt: input.expireAt,
        revenueType: input.revenueType,
        forecastMonths: input.forecastMonths,
      });

      return {
        ...result,
        shortUrl: `${process.env.MIDDAY_DASHBOARD_URL}/r/${result?.linkId}`,
      };
    }),

  listShared: protectedProcedure
    .input(listSharedReportsSchema)
    .query(({ ctx: { db, teamId }, input }) =>
      listSharedReports(db, { ...input, teamId: teamId! }),
    ),

  revoke: ownerProcedure
    .input(revokeSharedReportSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const result = await revokeSharedReport(db, {
        id: input.id,
        teamId: teamId!,
      });
      if (!result)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Shared report not found",
        });
      return result;
    }),

  getByLinkId: publicProcedure
    .input(getReportByLinkIdSchema)
    .query(async ({ ctx: { db }, input }) => {
      return getReportByLinkId(db, input.linkId);
    }),

  getChartDataByLinkId: publicProcedure
    .input(getChartDataByLinkIdSchema)
    .query(async ({ ctx: { db }, input }) => {
      try {
        return await getChartDataByLinkId(db, input.linkId);
      } catch (error: unknown) {
        if (error instanceof ReportNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: error.message,
          });
        }
        if (error instanceof ReportExpiredError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: error.message,
          });
        }
        if (error instanceof InvalidReportTypeError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }
        throw error;
      }
    }),
});
