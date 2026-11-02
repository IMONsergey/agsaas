import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "../types";
import { getAuthCookieOptions } from "./cookie-options";
import { createSupabaseFetch } from "./server-fetch";

type CreateClientOptions = {
  admin?: boolean;
  schema?: "public" | "storage";
};

/**
 * Disposable public Auth client for checking a current password. Its AAL1
 * login is kept in instance-local memory and can never overwrite SSR cookies.
 */
export function createPasswordVerificationClient() {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  getAuthCookieOptions(publicUrl); // Validate the same canonical URL boundary.
  const transport = createSupabaseFetch(publicUrl);
  const boundedFetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) =>
      transport(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      }),
    {
      preconnect: (
        url: Parameters<typeof globalThis.fetch.preconnect>[0],
        options?: Parameters<typeof globalThis.fetch.preconnect>[1],
      ) => transport.preconnect?.(url, options),
    },
  );
  const client = createSupabaseClient<Database>(
    publicUrl,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: boundedFetch,
      },
    },
  );
  // Expose only Auth: no database, Storage or inferred schema generics are
  // needed by this disposable verifier.
  return { auth: client.auth };
}

export async function createClient(options?: CreateClientOptions) {
  const { admin = false, ...rest } = options ?? {};
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const cookieStore = await cookies();

  const key = admin
    ? process.env.SUPABASE_SECRET_KEY!
    : process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

  const auth = admin
    ? {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      }
    : {};

  const client = createServerClient<Database>(publicUrl, key, {
    ...rest,
    cookieOptions: getAuthCookieOptions(publicUrl),
    global: {
      fetch: createSupabaseFetch(publicUrl),
    },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // The `setAll` method was called from a Server Component.
          // This can be ignored if you have middleware refreshing
          // user sessions.
        }
      },
    },
    auth,
  });

  // The middleware validates and refreshes tokens via getClaims().
  // Server components only call getSession() to read the access token
  // from cookies — suppress the "use getUser() instead" warning.
  // @ts-expect-error - suppressGetSessionWarning is a protected property
  client.auth.suppressGetSessionWarning = true;

  return client;
}
