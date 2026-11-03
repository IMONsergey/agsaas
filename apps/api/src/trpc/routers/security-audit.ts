import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { resolveSecurityAuditScope } from "@api/utils/security-audit-scope";
import { listSecurityAuditEvents } from "@midday/db/queries";
import { z } from "zod";

export const securityAuditRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(50),
          beforeId: z
            .string()
            .regex(/^[0-9]{1,24}$/)
            .optional(),
        })
        .optional(),
    )
    .query(async ({ ctx: { db, teamId, session }, input }) => {
      const scope = await resolveSecurityAuditScope(db, {
        teamId,
        actorUserId: session.user.id,
      });
      return {
        ...(await listSecurityAuditEvents(db, { ...input, ...scope })),
        scope: scope.teamId
          ? ("team-and-personal" as const)
          : ("personal" as const),
      };
    }),
});
