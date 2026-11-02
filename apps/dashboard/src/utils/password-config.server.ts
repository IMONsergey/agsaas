import "server-only";
import { getEnabledAuthProviders } from "./auth-methods.server";

/** Auth SMTP is separate from product email/Resend. This opt-in is explicit. */
export function getPasswordCapabilities() {
  const password = getEnabledAuthProviders().includes("password");
  return {
    passwordChange: { enabled: password },
    passwordRecovery: {
      enabled:
        password && process.env.AUTH_PASSWORD_RECOVERY_ENABLED === "true",
    },
  };
}
