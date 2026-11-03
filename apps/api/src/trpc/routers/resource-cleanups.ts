import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { resolveSecurityAuditScope } from "@api/utils/security-audit-scope";
import {
  acknowledgeManualCleanup,
  listResourceCleanups,
} from "@midday/db/queries";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export const resourceCleanupsRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx: { db, session, teamId } }) => {
    const scope = await resolveSecurityAuditScope(db, {
      teamId,
      actorUserId: session.user.id,
    });
    return listResourceCleanups(db, scope);
  }),
  acknowledge: protectedProcedure
    .input(
      z
        .object({
          id: z.string().uuid(),
          evidenceReference: z.string().regex(/^[A-Z0-9][A-Z0-9._:-]{5,127}$/i),
          confirmedExternally: z.literal(true),
        })
        .strict(),
    )
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      try {
        return await acknowledgeManualCleanup(db, {
          id: input.id,
          teamId,
          actorUserId: session.user.id,
          evidenceReference: input.evidenceReference,
        });
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This cleanup cannot be confirmed by this account or requires machine verification",
        });
      }
    }),
});
