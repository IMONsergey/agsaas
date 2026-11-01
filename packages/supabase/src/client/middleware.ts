import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";
import { getAuthCookieOptions } from "./cookie-options";
import { createSupabaseFetch } from "./server-fetch";

export async function updateSession(
  request: NextRequest,
  response: NextResponse,
) {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabase = createServerClient(
    publicUrl,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: getAuthCookieOptions(publicUrl),
      global: {
        fetch: createSupabaseFetch(publicUrl),
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Do not run code between createServerClient and getClaims().
  // A simple mistake could make it very hard to debug issues with
  // users being randomly logged out.
  //
  // getClaims() validates the JWT signature against the project's
  // published JWKS and refreshes expired tokens. Never trust
  // getSession() inside server code — it isn't guaranteed to
  // revalidate the Auth token.
  const { data, error } = await supabase.auth.getClaims();
  const isAuthenticated = !!data && !error;

  return {
    response,
    isAuthenticated,
    supabase,
  };
}
