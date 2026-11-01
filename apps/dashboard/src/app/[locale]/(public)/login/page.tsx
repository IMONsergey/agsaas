import { createClient } from "@midday/supabase/server";
import { Icons } from "@midday/ui/icons";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { AuthErrorToast } from "@/components/auth-error-toast";
import { LoginAccordion } from "@/components/login-accordion";
import { LoginVideoBackground } from "@/components/login-video-background";
import { OAuthSignIn } from "@/components/oauth-sign-in";
import { OTPSignIn } from "@/components/otp-sign-in";
import { PasswordSignIn } from "@/components/password-sign-in";
import { type AuthProvider, selectSignInOptions } from "@/utils/auth-methods";
import { getEnabledAuthProviders } from "@/utils/auth-methods.server";
import { Cookies } from "@/utils/constants";
import { isBlockedNewUser } from "@/utils/new-user-gate";

export const metadata: Metadata = {
  title: "Sign in | AGSaaS",
};

type Props = {
  searchParams: Promise<{ waitlist?: string }>;
};

export default async function Page({ searchParams }: Props) {
  const { waitlist: waitlistParam } = await searchParams;
  const enabled = getEnabledAuthProviders();
  const cookieStore = await cookies();
  const preferred = cookieStore.get(Cookies.PreferredSignInProvider)?.value;
  const { primary, alternatives } = selectSignInOptions(enabled, preferred);

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const showQueueNotice =
    waitlistParam === "1" || isBlockedNewUser(authUser?.created_at);

  function signInOption(provider: AuthProvider) {
    if (provider === "email") return <OTPSignIn />;
    if (provider === "password") return <PasswordSignIn />;
    return (
      <OAuthSignIn provider={provider} showLastUsed={preferred === provider} />
    );
  }

  return (
    <div className="min-h-screen bg-background flex relative">
      <AuthErrorToast />
      <div className="fixed top-0 left-0 right-0 z-50 w-full">
        <nav className="w-full pointer-events-none">
          <div className="relative py-3 xl:py-4 px-4 sm:px-4 md:px-4 lg:px-4 xl:px-6 2xl:px-8 flex items-center">
            <Link
              href="/"
              aria-label="AGSaaS home"
              className="flex items-center gap-2 hover:opacity-80 active:opacity-80 transition-opacity duration-200 pointer-events-auto"
            >
              <div className="w-6 h-6">
                <Icons.LogoSmall className="w-full h-full text-foreground lg:text-white" />
              </div>
            </Link>
          </div>
        </nav>
      </div>

      <LoginVideoBackground />

      <div className="w-full lg:w-1/2 flex flex-col justify-center items-center p-8 lg:p-12 pb-2">
        <div className="w-full max-w-md flex flex-col h-full">
          <div className="space-y-8 flex-1 flex flex-col justify-center">
            {showQueueNotice ? (
              <div className="text-center space-y-2">
                <h1 className="text-lg lg:text-xl mb-4 font-serif">
                  Account access is not available
                </h1>
                <p className="font-sans text-sm text-[#878787]">
                  Contact the workspace owner to check access to your account.
                </p>
              </div>
            ) : (
              <>
                <div className="text-center space-y-2">
                  <h1 className="text-lg lg:text-xl mb-4 font-serif">
                    Welcome to AGSaaS
                  </h1>
                  <p className="font-sans text-sm text-[#878787]">
                    Sign in to your account
                  </p>
                </div>

                <div className="space-y-3 flex items-center justify-center w-full">
                  {signInOption(primary)}
                </div>

                {alternatives.length > 0 && (
                  <>
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-border" />
                      </div>
                      <div className="relative flex justify-center text-sm">
                        <span className="px-2 bg-background font-sans text-[#878787]">
                          or
                        </span>
                      </div>
                    </div>
                    <LoginAccordion>
                      {alternatives.map((provider) => (
                        <div key={provider}>{signInOption(provider)}</div>
                      ))}
                    </LoginAccordion>
                  </>
                )}
              </>
            )}
          </div>

          <div className="text-center mt-auto">
            <p className="font-sans text-xs text-[#878787]">
              Use your own account to access this workspace.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
