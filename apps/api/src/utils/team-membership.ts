import { TeamMembershipError } from "@midday/db/errors";
import { TRPCError } from "@trpc/server";

/** Preserve infrastructure errors; only policy failures become FORBIDDEN. */
export async function withTeamMembershipErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TeamMembershipError) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}
