"use server";

import { z } from "zod";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@/utils/password-policy";
import { requirePasswordSession } from "@/utils/password-session.server";
import { actionClient } from "./safe-action";

export const resetPasswordAction = actionClient
  .schema(
    z.object({
      password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
    }),
  )
  .action(async ({ parsedInput: { password } }) => {
    const { supabase, user } = await requirePasswordSession({ recovery: true });
    try {
      const { data, error } = await supabase.auth.updateUser({ password });
      if (error || data.user?.id !== user.id) throw new Error();
    } catch {
      throw new Error(
        "Unable to reset your password. Choose a different password or request a new link.",
      );
    }
    // Finish this recovery session and return to an ordinary password login.
    // A logout transport failure must not pretend that the password write failed.
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* Do not log Auth responses. */
    }
    return { updated: true };
  });
