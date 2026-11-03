import { updateUserSchema } from "@api/schemas/users";
import { resend } from "@api/services/resend";
import { createAdminClient } from "@api/services/supabase";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { withRetryOnPrimary } from "@api/utils/db-retry";
import { withTeamMembershipErrors } from "@api/utils/team-membership";
import { teamCache } from "@midday/cache/team-cache";
import {
  deleteUser,
  getOwnAuthSessions,
  revokeAuthSessions,
  getUserById,
  getUserInvites,
  switchUserTeam,
  updateUser,
} from "@midday/db/queries";
import { FILE_KEY_TTL_SECONDS, generateFileKey } from "@midday/encryption";
import { logger } from "@midday/logger";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    // Cookie-based approach handles replication lag for new users via x-force-primary header
    // Retry logic still handles connection errors/timeouts
    const result = await withRetryOnPrimary(db, async (dbInstance) =>
      getUserById(dbInstance, session.user.id),
    );

    if (!result) {
      return undefined;
    }

    return {
      ...result,
      fileKey: result.teamId && session.sessionId
        ? await generateFileKey({
            teamId: result.teamId,
            sessionId: session.sessionId,
            userId: session.user.id,
            aal: session.aal ?? "aal1",
          })
        : null,
      // Conservative browser deadline prevents reusing cached expired URLs
      // after a suspended tab wakes up, while user.me refreshes its key.
      fileKeyExpiresAt: result.teamId && session.sessionId
        ? Date.now() + (FILE_KEY_TTL_SECONDS - 5) * 1000
        : null,
    };
  }),

  sessions: protectedProcedure.query(({ctx:{db,session}})=>{
    if(!session.sessionId)throw new TRPCError({code:"UNAUTHORIZED",message:"A current browser session is required."});
    return getOwnAuthSessions(db,session.user.id,session.sessionId);
  }),
  revokeSessions: protectedProcedure.input(z.object({scope:z.enum(["all","others"])}))
    .mutation(({ctx:{db,session},input})=>{
      if(!session.sessionId)throw new TRPCError({code:"UNAUTHORIZED",message:"A current browser session is required."});
      return revokeAuthSessions(db,session.user.id,session.sessionId,input.scope);
    }),

  update: protectedProcedure
    .input(updateUserSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      return updateUser(db, {
        id: session.user.id,
        ...input,
      });
    }),

  switchTeam: protectedProcedure
    .input(z.object({ teamId: z.string().uuid() }))
    .mutation(async ({ ctx: { db, session }, input }) => {
      let result: Awaited<ReturnType<typeof switchUserTeam>>;

      try {
        result = await switchUserTeam(db, {
          userId: session.user.id,
          teamId: input.teamId,
        });
      } catch {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a member of this team",
        });
      }

      try {
        await Promise.all([
          teamCache.invalidateForUser(session.user.id, result.previousTeamId),
          teamCache.invalidateForUser(session.user.id, input.teamId),
        ]);
      } catch {
        // Non-fatal — cache will expire naturally
      }

      return result;
    }),

  delete: protectedProcedure.mutation(async ({ ctx: { db, session } }) => {
    const data = await withTeamMembershipErrors(() =>
      deleteUser(db, session.user.id, async () => {
        try {
          const supabaseAdmin = await createAdminClient({
            signal: AbortSignal.timeout(10_000),
          });
          const { error } = await supabaseAdmin.auth.admin.deleteUser(
            session.user.id,
          );
          // A second request after a successful deletion is harmless. Other
          // returned SDK errors are failures, even if the promise resolved.
          if (error && error.code !== "user_not_found") throw error;
        } catch {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Account deletion could not be confirmed. Team access has been removed; retry deletion or sign in again to check your account.",
          });
        }
      }),
    );

    try {
      await teamCache.invalidateForUser(session.user.id);
    } catch {
      // Authorization reads primary membership/profile state, not this cache.
    }

    // Marketing is optional and cannot race or undo the core account deletion.
    if (
      process.env.RESEND_API_KEY?.trim() &&
      process.env.RESEND_AUDIENCE_ID?.trim() &&
      session.user.email
    ) {
      try {
        const { error } = await resend.contacts.remove({
          email: session.user.email,
          audienceId: process.env.RESEND_AUDIENCE_ID,
        });
        if (error)
          logger.warn("Account deleted; marketing contact cleanup failed");
      } catch {
        logger.warn("Account deleted; marketing contact cleanup failed");
      }
    }

    return data;
  }),

  invites: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    if (!session.user.email) {
      return [];
    }

    return getUserInvites(db, session.user.email);
  }),
});
