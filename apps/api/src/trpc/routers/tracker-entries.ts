import {
  deleteTrackerEntrySchema,
  getBillableHoursSchema,
  getCurrentTimerSchema,
  getTrackerRecordsByDateSchema,
  getTrackerRecordsByRangeSchema,
  startTimerSchema,
  stopTimerSchema,
  upsertTrackerEntriesSchema,
} from "@api/schemas/tracker-entries";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  deleteTrackerEntry,
  getBillableHours,
  getCurrentTimer,
  getTimerStatus,
  getTrackerRecordsByDate,
  getTrackerRecordsByRange,
  startTimer,
  stopTimer,
  upsertTrackerEntries,
} from "@midday/db/queries";
import { InvoiceFinancialStateError } from "@midday/invoice/calculate";
import { TRPCError } from "@trpc/server";

async function trackerWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof InvoiceFinancialStateError)
      throw new TRPCError({
        code: "CONFLICT",
        message: error.message,
        cause: error,
      });
    throw error;
  }
}

export const trackerEntriesRouter = createTRPCRouter({
  getBillableHours: protectedProcedure
    .input(getBillableHoursSchema)
    .query(async ({ ctx: { db, teamId, session }, input }) => {
      return getBillableHours(db, {
        teamId: teamId!,
        date: input.date,
        view: input.view,
        weekStartsOnMonday: input.weekStartsOnMonday,
        timezone: input.timezone,
      });
    }),

  byDate: protectedProcedure
    .input(getTrackerRecordsByDateSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getTrackerRecordsByDate(db, {
        date: input.date,
        teamId: teamId!,
      });
    }),

  byRange: protectedProcedure
    .input(getTrackerRecordsByRangeSchema)
    .query(async ({ input, ctx: { db, session, teamId } }) => {
      return getTrackerRecordsByRange(db, {
        teamId: teamId!,
        userId: session.user.id,
        ...input,
      });
    }),

  upsert: protectedProcedure
    .input(upsertTrackerEntriesSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return trackerWrite(() =>
        upsertTrackerEntries(db, {
          ...input,
          teamId: teamId!,
        }),
      );
    }),

  delete: protectedProcedure
    .input(deleteTrackerEntrySchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return trackerWrite(() =>
        deleteTrackerEntry(db, {
          teamId: teamId!,
          id: input.id,
        }),
      );
    }),

  // Timer procedures
  startTimer: protectedProcedure
    .input(startTimerSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      return startTimer(db, {
        teamId: teamId!,
        assignedId: input.assignedId ?? session.user.id,
        ...input,
      });
    }),

  stopTimer: protectedProcedure
    .input(stopTimerSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      return stopTimer(db, {
        teamId: teamId!,
        assignedId: input.assignedId ?? session.user.id,
        ...input,
      });
    }),

  getCurrentTimer: protectedProcedure
    .input(getCurrentTimerSchema.optional())
    .query(async ({ ctx: { db, teamId, session }, input }) => {
      return getCurrentTimer(db, {
        teamId: teamId!,
        assignedId: input?.assignedId ?? session.user.id,
      });
    }),

  getTimerStatus: protectedProcedure
    .input(getCurrentTimerSchema.optional())
    .query(async ({ ctx: { db, teamId, session }, input }) => {
      return getTimerStatus(db, {
        teamId: teamId!,
        assignedId: input?.assignedId ?? session.user.id,
      });
    }),
});
