import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/db";
import { createSupabaseFetch } from "./server-fetch";

export const createClient = () => {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL! || process.env.SUPABASE_URL!;
  return createSupabaseClient<Database>(url, process.env.SUPABASE_SECRET_KEY!, {
    global: { fetch: createSupabaseFetch(url) },
  });
};
