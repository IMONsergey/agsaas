"use server";

import { createClient } from "@midday/supabase/server";
import { addSeconds, addYears } from "date-fns";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAuthOperationSession } from "@/utils/auth-flow";
import { getEnabledAuthProviders } from "@/utils/auth-methods.server";
import { getAuthRedirectUrl } from "@/utils/auth-redirect";
import { Cookies } from "@/utils/constants";
import { getUrl } from "@/utils/environment";
import { isBlockedNewUser } from "@/utils/new-user-gate";
import { actionClient } from "./safe-action";

export const verifyOtpAction = actionClient
  .schema(
    z.object({
      token: z.string(),
      email: z.string(),
      redirectTo: z.string().max(2048),
    }),
  )
  .action(async ({ parsedInput: { email, token, redirectTo } }) => {
    if (!getEnabledAuthProviders().includes("email")) {
      throw new Error(
        "Unable to verify the code. Please try again or request a new code.",
      );
    }
    const destination = getAuthRedirectUrl(redirectTo, getUrl());
    const supabase = await createClient();

    const session = await getAuthOperationSession(() =>
      supabase.auth.verifyOtp({
        email,
        token,
        type: "email",
      }),
    );

    if (!session) {
      throw new Error(
        "Unable to verify the code. Please try again or request a new code.",
      );
    }

    if (isBlockedNewUser(session.user.created_at)) {
      await supabase.auth.signOut();
      redirect(`${getUrl()}/login?waitlist=1`);
    }

    const cookieStore = await cookies();

    cookieStore.set(Cookies.PreferredSignInProvider, "otp", {
      expires: addYears(new Date(), 1),
    });

    // Force primary database reads for subsequent requests after redirect.
    // This prevents replication lag issues when the user record hasn't
    // replicated to read replicas yet (same as the OAuth callback).
    cookieStore.set(Cookies.ForcePrimary, "true", {
      expires: addSeconds(new Date(), 30),
      httpOnly: false, // Needs to be readable by client-side tRPC
      sameSite: "lax",
    });

    redirect(destination);
  });
