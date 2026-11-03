import { supportSubmissionSchema } from "@api/schemas/support";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  getOwnSupportRequests,
  SupportRequestError,
  submitSupportRequest,
} from "@midday/db/queries";
import { TRPCError } from "@trpc/server";
export const supportRouter = createTRPCRouter({
  submit: protectedProcedure
    .input(supportSubmissionSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      if (!teamId || !session.user.email)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A workspace and account email are required.",
        });
      try {
        return await submitSupportRequest(db, {
          id: input.requestId,
          source: "dashboard",
          scopeKey: `user:${session.user.id}`,
          teamId,
          userId: session.user.id,
          email: session.user.email,
          fullName: session.user.email,
          subject: input.subject,
          priority: input.priority,
          product: input.type,
          message: input.message,
        });
      } catch (error) {
        if (error instanceof SupportRequestError)
          throw new TRPCError({
            code: error.code === "CONFLICT" ? "CONFLICT" : "TOO_MANY_REQUESTS",
            message:
              error.code === "CONFLICT"
                ? "This request reference was already used. Reload to start a new request."
                : "Too many support requests. Please try later.",
          });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Receipt could not be confirmed. Retry with the same request reference.",
        });
      }
    }),
  mine: protectedProcedure.query(({ ctx: { db, teamId, session } }) =>
    getOwnSupportRequests(db, teamId!, session.user.id),
  ),
});
