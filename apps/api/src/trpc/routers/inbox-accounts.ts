import {
  connectInboxAccountSchema,
  deleteInboxAccountSchema,
  exchangeCodeForAccountSchema,
  syncInboxAccountSchema,
} from "@api/schemas/inbox-accounts";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { getInstanceCapabilities } from "@api/utils/instance-capabilities";
import {
  deleteInboxAccount,
  getInboxAccountById,
  getInboxAccounts,
} from "@midday/db/queries";
import { removeInboxSyncScheduler, triggerJob } from "@midday/job-client";
import { logger } from "@midday/logger";
import { TRPCError } from "@trpc/server";

export const inboxAccountsRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getInboxAccounts(db, teamId!);
  }),

  connect: protectedProcedure.input(connectInboxAccountSchema).mutation(() => {
    // Streaming tRPC responses cannot reliably set a callback nonce cookie.
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Start the inbox connection from the browser handshake",
    });
  }),

  exchangeCodeForAccount: protectedProcedure
    .input(exchangeCodeForAccountSchema)
    .query(() => {
      // All codes must pass the durable intent + browser-cookie boundary.
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Complete the inbox connection through its browser callback",
      });
    }),

  delete: protectedProcedure
    .input(deleteInboxAccountSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const data = await deleteInboxAccount(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!data) return data;
      try {
        // The row was deleted with a tenant predicate. Its UUID determines our
        // own Redis scheduler; scheduleId may still contain a legacy cloud ID.
        await removeInboxSyncScheduler(data.id);
        return { ...data, schedulerCleanupPending: false };
      } catch {
        // Credentials are already removed. A persisted scheduler self-removes
        // when its next worker run observes the missing account after recovery.
        logger.warn("Inbox account removed; scheduler cleanup deferred", {
          accountId: data.id,
        });
        return { ...data, schedulerCleanupPending: true };
      }
    }),

  sync: protectedProcedure
    .input(syncInboxAccountSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      // Verify the inbox account belongs to the caller's team
      const account = await getInboxAccountById(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!account) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Inbox account not found",
        });
      }

      if (!getInstanceCapabilities().integrations[account.provider]?.enabled) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This email provider is not configured for this installation",
        });
      }
      const event = await triggerJob(
        "sync-scheduler",
        {
          id: input.id,
          teamId: teamId!,
          manualSync: input.manualSync || false,
        },
        "inbox-provider",
      );

      return event;
    }),
});
