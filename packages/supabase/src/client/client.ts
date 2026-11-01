import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "../types";
import { getAuthCookieOptions } from "./cookie-options";

export const createClient = () => {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return createBrowserClient<Database>(
    publicUrl,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookieOptions: getAuthCookieOptions(publicUrl) },
  );
};
