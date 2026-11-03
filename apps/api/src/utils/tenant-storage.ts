import {
  InvalidStorageKeyError,
  requireVaultPathForTeam,
} from "@midday/utils/storage-path";
import { TRPCError } from "@trpc/server";

export function validateTeamStoragePath(
  path: string | readonly string[],
  teamId: string,
) {
  try {
    return requireVaultPathForTeam(path, teamId);
  } catch (error) {
    if (error instanceof InvalidStorageKeyError) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Invalid file reference",
      });
    }
    throw error;
  }
}
