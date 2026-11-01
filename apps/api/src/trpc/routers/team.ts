import {
  acceptTeamInviteSchema,
  createTeamSchema,
  declineTeamInviteSchema,
  deleteTeamInviteSchema,
  deleteTeamMemberSchema,
  deleteTeamSchema,
  inviteTeamMembersSchema,
  leaveTeamSchema,
  updateBaseCurrencySchema,
  updateTeamByIdSchema,
  updateTeamMemberSchema,
} from "@api/schemas/team";
import { enqueueTeamInvitations } from "@api/services/team-invitation-queue";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { withTeamMembershipErrors } from "@api/utils/team-membership";

import { teamCache } from "@midday/cache/team-cache";
import {
  acceptTeamInvite,
  createTeam,
  createTeamInvites,
  declineTeamInvite,
  deleteTeam,
  deleteTeamInvite,
  deleteTeamMember,
  getAvailablePlans,
  getBankConnections,
  getInboxAccounts,
  getInvitesByEmail,
  getTeamById,
  getTeamInvites,
  getTeamMembersByTeamId,
  getTeamsByUserId,
  leaveTeam,
  updateTeamById,
  updateTeamMember,
} from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import { getTeamInviteEmailConfig } from "@midday/notifications/team-invitation-config";
import { TRPCError } from "@trpc/server";

export const teamRouter = createTRPCRouter({
  current: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    if (!teamId) {
      return null;
    }

    return getTeamById(db, teamId!);
  }),

  update: protectedProcedure
    .input(updateTeamByIdSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return updateTeamById(db, {
        id: teamId!,
        data: input,
      });
    }),

  members: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getTeamMembersByTeamId(db, teamId!);
  }),

  list: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    return getTeamsByUserId(db, session.user.id);
  }),

  create: protectedProcedure
    .input(createTeamSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      const teamId = await withTeamMembershipErrors(() =>
        createTeam(db, {
          ...input,
          userId: session.user.id,
          email: session.user.email!,
          companyType: input.companyType,
        }),
      );

      if (input.switchTeam) {
        try {
          await teamCache.invalidateForUser(session.user.id);
        } catch {
          // Non-fatal — cache will expire naturally
        }
      }

      return teamId;
    }),

  leave: protectedProcedure
    .input(leaveTeamSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      const result = await withTeamMembershipErrors(() =>
        leaveTeam(db, { userId: session.user.id, teamId: input.teamId }),
      );

      try {
        await teamCache.invalidateForUser(session.user.id, input.teamId);
      } catch {
        // Non-fatal — cache will expire naturally
      }

      return result;
    }),

  acceptInvite: protectedProcedure
    .input(acceptTeamInviteSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      const userEmail = session.user.email;
      if (!userEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Email is required to accept an invite",
        });
      }

      return withTeamMembershipErrors(() =>
        acceptTeamInvite(db, {
          id: input.id,
          userId: session.user.id,
          userEmail,
        }),
      );
    }),

  declineInvite: protectedProcedure
    .input(declineTeamInviteSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      return declineTeamInvite(db, {
        id: input.id,
        email: session.user.email!,
      });
    }),

  delete: protectedProcedure
    .input(deleteTeamSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      const data = await withTeamMembershipErrors(() =>
        deleteTeam(db, { teamId: input.teamId, userId: session.user.id }),
      );

      if (!data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete team",
        });
      }

      try {
        await Promise.all([
          ...data.memberUserIds.map((userId) =>
            Promise.all([teamCache.invalidateForUser(userId, input.teamId)]),
          ),
        ]);
      } catch {
        // Non-fatal — team deletion succeeded, cache will expire naturally
      }
      return { id: data.id, cleanupPending: data.cleanupPending };
    }),

  deleteMember: protectedProcedure
    .input(deleteTeamMemberSchema)
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      if (input.teamId !== teamId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have access to this team",
        });
      }

      const result = await withTeamMembershipErrors(() =>
        deleteTeamMember(db, {
          teamId: input.teamId,
          userId: input.userId,
          actorId: session.user.id,
        }),
      );

      try {
        await teamCache.invalidateForUser(input.userId, input.teamId);
      } catch {
        // Non-fatal — cache will expire naturally
      }

      return result;
    }),

  updateMember: protectedProcedure
    .input(updateTeamMemberSchema)
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      if (input.teamId !== teamId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have access to this team",
        });
      }

      return withTeamMembershipErrors(() =>
        updateTeamMember(db, { ...input, actorId: session.user.id }),
      );
    }),

  teamInvites: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getTeamInvites(db, teamId!);
  }),

  invitesByEmail: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    return getInvitesByEmail(db, session.user.email!);
  }),

  invite: protectedProcedure
    .input(inviteTeamMembersSchema)
    .mutation(async ({ ctx: { db, session, teamId, geo }, input }) => {
      const invitedByEmail = session.user.email;
      if (!invitedByEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Email is required to invite team members",
        });
      }

      if (!teamId)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose a team before inviting members",
        });
      try {
        getTeamInviteEmailConfig();
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Invitation email is not configured for this installation",
        });
      }
      const data = await withTeamMembershipErrors(() =>
        createTeamInvites(db, {
          teamId,
          actorId: session.user.id,
          deliveryContext: {
            invitedByEmail,
            invitedByName: session.user.full_name ?? "",
            locale: "en",
            ...(geo.ip ? { ip: geo.ip } : {}),
          },
          invites: input.map((invite) => ({
            ...invite,
            invitedBy: session.user.id,
          })),
        }),
      );
      await enqueueTeamInvitations(
        data.results.map((invite) => ({
          teamId,
          inviteId: invite.id,
          deliveryId: invite.deliveryId,
        })),
      );
      return {
        queued: data.results.length,
        skipped: data.skippedInvites.length,
        skippedInvites: data.skippedInvites,
      };
    }),

  deleteInvite: protectedProcedure
    .input(deleteTeamInviteSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      return withTeamMembershipErrors(() =>
        deleteTeamInvite(db, {
          teamId: teamId!,
          id: input.id,
          actorId: session.user.id,
        }),
      );
    }),

  availablePlans: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getAvailablePlans(db, teamId!);
  }),

  updateBaseCurrency: protectedProcedure
    .input(updateBaseCurrencySchema)
    .mutation(async ({ ctx: { teamId }, input }) => {
      return triggerJob(
        "update-base-currency",
        {
          teamId: teamId!,
          baseCurrency: input.baseCurrency,
        },
        "transactions",
      );
    }),

  exportAllData: protectedProcedure.mutation(
    async ({ ctx: { teamId, session } }) => {
      if (!teamId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Team not found",
        });
      }

      return triggerJob(
        "export-team-data",
        {
          teamId,
          userId: session.user.id,
          userEmail: session.user.email ?? undefined,
        },
        "transactions",
      );
    },
  ),

  /**
   * Get unified connection status for the team.
   * Returns raw connection data - presentation logic handled by client.
   */
  connectionStatus: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      if (!teamId) {
        return { bankConnections: [], inboxAccounts: [] };
      }

      // Fetch bank connections and inbox accounts in parallel
      const [bankConnections, inboxAccounts] = await Promise.all([
        getBankConnections(db, { teamId }),
        getInboxAccounts(db, teamId),
      ]);

      return {
        bankConnections: bankConnections.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          expiresAt: c.expiresAt,
          logoUrl: c.logoUrl,
        })),
        inboxAccounts: inboxAccounts.map((a) => ({
          id: a.id,
          email: a.email,
          status: a.status,
          provider: a.provider,
        })),
      };
    },
  ),
});
