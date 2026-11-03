import { updateSession } from "@midday/supabase/middleware";
import { getAppUrl } from "@midday/utils/envs";
import { type NextRequest, NextResponse } from "next/server";
import { createI18nMiddleware } from "next-international/middleware";
import pdfPublicAssets from "@/utils/pdf-public-assets.json";

const ORIGIN = getAppUrl();
// Only reviewed, publicly distributed build files can bypass session handling.
// The asset preparer checks this pinned inventory against React-PDF's dependency.
const publicAssetPaths = new Set([
  "/appicon.png",
  "/assets/bg-login.jpg",
  "/assets/bg-login-dark.jpg",
  ...pdfPublicAssets.files.map(
    (name) => `/vendor/pdfjs/${pdfPublicAssets.version}/${name}`,
  ),
]);

const I18nMiddleware = createI18nMiddleware({
  locales: ["en"],
  defaultLocale: "en",
  urlMappingStrategy: "rewrite",
});

export async function proxy(request: NextRequest) {
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    publicAssetPaths.has(request.nextUrl.pathname)
  )
    return NextResponse.next();

  const { response, isAuthenticated, supabase } = await updateSession(
    request,
    I18nMiddleware(request),
  );

  // A refresh can occur before navigation; carry its cookies onto redirects.
  const redirectWithSession = (url: URL | string) => {
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll())
      redirect.cookies.set(cookie);
    return redirect;
  };
  const nextUrl = request.nextUrl;

  const pathnameWithoutLocale = nextUrl.pathname.replace(/^\/en(?=\/|$)/, "");
  const newUrl = new URL(ORIGIN);
  newUrl.pathname = pathnameWithoutLocale || "/";
  newUrl.search = nextUrl.search;

  const encodedSearchParams = `${newUrl?.pathname?.substring(1)}${
    newUrl.search
  }`;

  if (
    !isAuthenticated &&
    newUrl.pathname !== "/login" &&
    newUrl.pathname !== "/forgot-password" &&
    newUrl.pathname !== "/reset-password" &&
    !/^\/(?:i|p|s|r)\/[^/]+(?:\/|$)/.test(newUrl.pathname) &&
    !/^\/(?:verify|oauth-callback|desktop\/search)(?:\/|$)/.test(
      newUrl.pathname,
    )
  ) {
    const loginUrl = new URL("/login", ORIGIN);

    if (encodedSearchParams) {
      loginUrl.searchParams.append("return_to", encodedSearchParams);
    }

    return redirectWithSession(loginUrl);
  }

  if (isAuthenticated) {
    const { data: mfaData } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (
      mfaData &&
      mfaData.nextLevel === "aal2" &&
      mfaData.nextLevel !== mfaData.currentLevel &&
      newUrl.pathname !== "/mfa/verify"
    ) {
      const mfaUrl = new URL("/mfa/verify", ORIGIN);

      if (encodedSearchParams) {
        mfaUrl.searchParams.append("return_to", encodedSearchParams);
      }

      return redirectWithSession(mfaUrl);
    }
    // Legacy invite links have no page of their own. The authenticated Teams
    // page shows only invitations bound to this account, after the MFA check.
    if (newUrl.pathname.startsWith("/teams/invite/")) {
      return redirectWithSession(new URL("/teams", ORIGIN));
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
