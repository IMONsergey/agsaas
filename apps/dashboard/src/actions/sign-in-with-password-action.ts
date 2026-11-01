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

const signInError =
  "Unable to sign in. Check your email and password and try again.";

export const signInWithPasswordAction = actionClient
  .schema(
    z.object({
      email: z.string().trim().email().max(320),
      password: z.string().min(1).max(1024),
      redirectTo: z.string().max(2048).default("/"),
    }),
  )
  .action(async ({ parsedInput: { email, password, redirectTo } }) => {
    // A hidden form is not an access control. Require server opt-in as well.
    if (!getEnabledAuthProviders().includes("password")) {
      throw new Error(signInError);
    }
    const destination = getAuthRedirectUrl(redirectTo, getUrl());
    const supabase = await createClient();
    const session = await getAuthOperationSession(() =>
      supabase.auth.signInWithPassword({ email, password }),
    );

    // Only the session returned by this successful Auth operation is accepted.
    // No account creation, email confirmation, admin session or ambient session.
    if (!session) throw new Error(signInError);

    if (isBlockedNewUser(session.user.created_at)) {
      await supabase.auth.signOut();
      redirect(`${getUrl()}/login?waitlist=1`);
    }

    const cookieStore = await cookies();
    cookieStore.set(Cookies.PreferredSignInProvider, "password", {
      expires: addYears(new Date(), 1),
      sameSite: "lax",
    });
    cookieStore.set(Cookies.ForcePrimary, "true", {
      expires: addSeconds(new Date(), 30),
      httpOnly: false,
      sameSite: "lax",
    });

    redirect(destination);
  });
