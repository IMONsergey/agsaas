import { createTRPCRouter, ownerProcedure } from "@api/trpc/init";
import { withTeamMembershipErrors } from "@api/utils/team-membership";
import {
  getBankSyncStatus,
  requestBankSyncForOwner,
} from "@midday/db/queries/bank-sync";
import { wakeNativeJob } from "@midday/job-client/native-wakeup";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

const scopeSchema = z.object({ connectionId: z.string().uuid() }).strict();
export const bankSyncRouter = createTRPCRouter({
  request: ownerProcedure
    .input(scopeSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const scope = { connectionId: input.connectionId, teamId: teamId! };
      const accepted = await withTeamMembershipErrors(() =>
        requestBankSyncForOwner(db, { ...scope, actorId: session.user.id }),
      );
      if (!accepted)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Bank connection not found",
        });
      const state = await getBankSyncStatus(db, scope);
      if (!state)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Bank connection not found",
        });
      // SQL is authoritative. Redis loss leaves a visible pending operation which
      // the minute reconciliation schedule will recover.
      try {
        await wakeNativeJob({ name: "sync-bank-connection", payload: scope });
      } catch {
        /* Durable SQL retry. */
      }
      return {
        connectionId: scope.connectionId,
        generation: state.requestedGeneration,
      };
    }),
  status: ownerProcedure
    .input(scopeSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      const state = await getBankSyncStatus(db, { ...input, teamId: teamId! });
      if (!state)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Bank connection not found",
        });
      return state;
    }),
});
