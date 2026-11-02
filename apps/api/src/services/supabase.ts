import { createSupabaseFetch } from "@midday/supabase/server-fetch";
import type { Database } from "@midday/supabase/types";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export async function createClient(accessToken?: string) {
  return createSupabaseClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      global: { fetch: createSupabaseFetch(process.env.SUPABASE_URL!) },
      accessToken() {
        return Promise.resolve(accessToken || "");
      },
    },
  );
}

export async function createAdminClient(
  options: { signal?: AbortSignal } = {},
) {
  const transport = createSupabaseFetch(process.env.SUPABASE_URL!);
  const signal = options.signal;
  const fetcher = signal
    ? Object.assign(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const signals = [signal];
          if (init?.signal) signals.push(init.signal);
          if (input instanceof Request) signals.push(input.signal);
          return transport(input, {
            ...init,
            signal: AbortSignal.any(signals),
          });
        },
        { preconnect: transport.preconnect },
      )
    : transport;
  return createSupabaseClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      global: { fetch: fetcher },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
