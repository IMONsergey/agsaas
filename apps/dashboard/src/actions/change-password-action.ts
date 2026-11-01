"use server";

import { createPasswordVerificationClient } from "@midday/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAuthOperationSession } from "@/utils/auth-flow";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@/utils/password-policy";
import { requirePasswordSession } from "@/utils/password-session.server";
import { actionClient } from "./safe-action";

const changeError =
  "Unable to change your password. Check your current password and choose a different new password.";

// Do not use authActionClient: its development middleware logs clientInput.
export const changePasswordAction = actionClient
  .schema(
    z.object({
      currentPassword: z.string().min(1).max(1024),
      password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
    }),
  )
  .action(async ({ parsedInput: { currentPassword, password } }) => {
    const { supabase, user } = await requirePasswordSession();
    let verifier:
      | ReturnType<typeof createPasswordVerificationClient>
      | undefined;
    try {
      if (currentPassword === password) throw new Error();
      verifier = createPasswordVerificationClient();
      const session = await getAuthOperationSession(() =>
        verifier!.auth.signInWithPassword({
          email: user.email!,
          password: currentPassword,
        }),
      );
      if (!session || session.user.id !== user.id) throw new Error();

      // Keep the original MFA-authenticated session. The separate verifier's
      // AAL1 token is never injected into it or written to response cookies.
      const { data, error } = await supabase.auth.updateUser({
        password,
        current_password: currentPassword,
      });
      if (error || data.user?.id !== user.id) throw new Error();
    } catch {
      throw new Error(changeError);
    } finally {
      // A disposable login must not revoke the original session via global logout.
      try {
        await verifier?.auth.signOut({ scope: "local" });
      } catch {
        /* No credentials or diagnostics logged. */
      }
    }
    revalidatePath("/account/security");
    return { updated: true };
  });
