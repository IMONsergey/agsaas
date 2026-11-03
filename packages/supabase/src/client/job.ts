import { getOperationSignal } from "@midday/utils/operation-context";
import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type { Database } from "../types/db";
import { withTeamStorage } from "../utils/team-storage";
import { createSupabaseFetch, withFetchAbortSignal } from "./server-fetch";

const createServiceClient = (): SupabaseClient<Database> => {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL! || process.env.SUPABASE_URL!;
  return createSupabaseClient<Database>(url, process.env.SUPABASE_SECRET_KEY!, {
    global: {
      fetch: withFetchAbortSignal(createSupabaseFetch(url), () => {
        const outer = getOperationSignal();
        const signals = [outer, AbortSignal.timeout(60_000)].filter(
          (s): s is AbortSignal => !!s,
        );
        return AbortSignal.any(signals);
      }),
    },
  });
};

/** Required for every per-team service-role Storage operation. */
export const createTeamClient = (teamId: string) =>
  withTeamStorage(createServiceClient(), teamId);

/** Unscoped service clients may perform DB/auth work, never private Storage IO. */
export const createClient = () =>
  new Proxy(createServiceClient(), {
    get(target, property) {
      if (property === "storage")
        throw new Error("Storage requires createTeamClient(teamId)");
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
