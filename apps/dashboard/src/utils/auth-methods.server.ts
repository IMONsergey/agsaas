import "server-only";

import { parseEnabledAuthProviders } from "./auth-methods";

/** Runtime, server-only configuration; never put this in NEXT_PUBLIC_* env. */
export function getEnabledAuthProviders() {
  return parseEnabledAuthProviders(process.env.AUTH_ENABLED_PROVIDERS);
}
