import { createClient } from "@midday/supabase/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuthOperationSession } from "@/utils/auth-flow";
import { getAuthRedirectUrl } from "@/utils/auth-redirect";
import { getUrl } from "@/utils/environment";
import { getPasswordCapabilities } from "@/utils/password-config.server";
import { isFreshPasswordRecovery } from "@/utils/password-policy";

export async function GET(request: NextRequest) {
  const failure = getAuthRedirectUrl(
    "/forgot-password?error=invalid_link",
    getUrl(),
  );
  const query = new URL(request.url).searchParams;
  const code = query.get("code");
  const redirect = (url: string) => {
    const response = NextResponse.redirect(url);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };
  if (
    !getPasswordCapabilities().passwordRecovery.enabled ||
    !code ||
    code.length > 4096 ||
    query.has("error")
  )
    return redirect(failure);
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    return redirect(failure);
  }
  const session = await getAuthOperationSession(() =>
    supabase.auth.exchangeCodeForSession(code),
  );
  if (!session) return redirect(failure);
  try {
    // Verify the returned token, not an ambient login or the SDK's mutable
    // local PKCE redirectType suffix. Auth issues the recovery AMR claim.
    const { data, error } = await supabase.auth.getClaims(session.access_token);
    if (error || !isFreshPasswordRecovery(data?.claims, session.user.id))
      throw new Error();
  } catch {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* No provider diagnostics. */
    }
    return redirect(failure);
  }
  // The ordinary proxy sends enrolled users through MFA before this form.
  return redirect(getAuthRedirectUrl("/reset-password", getUrl()));
}
