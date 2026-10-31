import {
  assertTeamStoragePath,
  StoragePathError,
} from "@midday/supabase/storage";
import { TRPCError } from "@trpc/server";

export function assertTeamFilePath(
  path: string | readonly string[],
  teamId: string,
): void {
  try {
    assertTeamStoragePath(path, teamId);
  } catch (error) {
    if (error instanceof StoragePathError) {
      throw new TRPCError({
        code: error.code === "TEAM_MISMATCH" ? "FORBIDDEN" : "BAD_REQUEST",
        message: error.message,
      });
    }
    throw error;
  }
}
