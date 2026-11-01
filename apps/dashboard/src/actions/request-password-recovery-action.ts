"use server";

import { createClient } from "@midday/supabase/server";
import { z } from "zod";
import { getAuthRedirectUrl } from "@/utils/auth-redirect";
import { getUrl } from "@/utils/environment";
import { getPasswordCapabilities } from "@/utils/password-config.server";
import { actionClient } from "./safe-action";

export const requestPasswordRecoveryAction = actionClient
  .schema(
    z.object({
      email: z.string().trim().email().max(320),
    }),
  )
  .action(async ({ parsedInput: { email } }) => {
    if (!getPasswordCapabilities().passwordRecovery.enabled) {
      throw new Error(
        "Password reset emails are not enabled for this installation.",
      );
    }
    const redirectTo = getAuthRedirectUrl(
      "/api/auth/password-recovery",
      getUrl(),
    );
    try {
      const supabase = await createClient();
      // SSR creates the PKCE verifier cookie. The link must return to this same
      // browser; no admin API or automatically confirmed account is involved.
      await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    } catch {
      // Deliberately indistinguishable from an unknown account/provider refusal.
      // Do not log email addresses or provider diagnostics.
    }
    return { accepted: true };
  });
