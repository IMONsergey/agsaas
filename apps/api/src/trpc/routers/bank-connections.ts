import {
  addProviderAccountsSchema,
  createBankConnectionSchema,
  deleteBankConnectionSchema,
  getBankConnectionsSchema,
  reconnectBankConnectionSchema,
} from "@api/schemas/bank-connections";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { withTeamMembershipErrors } from "@api/utils/team-membership";

import {
  addProviderAccounts,
  createBankConnection,
  deleteBankConnection,
  getBankConnections,
  listBankConnectionCleanupStatus,
  reconnectBankConnection,
} from "@midday/db/queries";
import type { InitialBankSetupPayload } from "@midday/jobs/schema";
import { tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";

export const bankConnectionsRouter = createTRPCRouter({
  cleanupStatus: protectedProcedure.query(({ ctx: { db, teamId } }) =>
    listBankConnectionCleanupStatus(db, teamId!),
  ),
  get: protectedProcedure
    .input(getBankConnectionsSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getBankConnections(db, {
        teamId: teamId!,
        enabled: input?.enabled,
      });
    }),

  create: protectedProcedure
    .input(createBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const data = await createBankConnection(db, {
        ...input,
        teamId: teamId!,
        userId: session.user.id,
      });

      if (!data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Bank connection not found",
        });
      }

      const event = await tasks.trigger("initial-bank-setup", {
        connectionId: data.id,
        teamId: teamId!,
      } satisfies InitialBankSetupPayload);

      return event;
    }),

  delete: protectedProcedure
    .input(deleteBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const data = await withTeamMembershipErrors(() =>
        deleteBankConnection(db, {
          id: input.id,
          teamId: teamId!,
          actorId: session.user.id,
        }),
      );

      if (!data) {
        throw new Error("Bank connection not found");
      }

      // SQL already retained the encrypted cleanup intent. The own worker
      // recovers it independently of this response and Redis availability.
      return {
        id: data.id,
        cleanupId: data.cleanupId,
        cleanupStatus: data.cleanupStatus,
      };
    }),

  addAccounts: protectedProcedure
    .input(addProviderAccountsSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const result = await addProviderAccounts(db, {
        connectionId: input.connectionId,
        teamId: teamId!,
        userId: session.user.id,
        accounts: input.accounts,
      });

      return result;
    }),

  reconnect: protectedProcedure
    .input(reconnectBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const result = await reconnectBankConnection(db, {
        referenceId: input.referenceId,
        newReferenceId: input.newReferenceId,
        expiresAt: input.expiresAt,
        teamId: teamId!,
      });

      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Bank connection not found",
        });
      }

      return result;
    }),
});
