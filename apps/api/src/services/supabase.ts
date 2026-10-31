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

export async function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { global: { fetch: createSupabaseFetch(process.env.SUPABASE_URL!) } },
  );
}
