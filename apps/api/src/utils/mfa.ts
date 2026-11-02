import { createAdminClient } from "@api/services/supabase";
import type { Session } from "./auth";

export class MfaPolicyError extends Error {
  constructor(public readonly reason: "required" | "unavailable") {
    super(
      reason === "required"
        ? "Complete multi-factor authentication to continue."
        : "Authentication verification is temporarily unavailable.",
    );
    this.name = "MfaPolicyError";
  }
}

/**
 * A valid first-factor JWT is insufficient after a factor has been verified.
 * Read the authoritative Auth factor list, not editable metadata or a cached
 * profile flag. An AAL2 session already satisfies either factor policy.
 * API keys/OAuth grants have their own scoped authorization, not an AAL claim.
 */
export async function requireSessionMfa(session: Session): Promise<void> {
  if (session.aal === "aal2") return;

  let hasVerifiedFactor: boolean;
  try {
    const admin = await createAdminClient({
      signal: AbortSignal.timeout(5_000),
    });
    const { data, error } = await admin.auth.admin.mfa.listFactors({
      userId: session.user.id,
    });
    if (
      error ||
      !data ||
      !Array.isArray(data.factors) ||
      data.factors.some(
        (factor) =>
          !factor ||
          (factor.status !== "verified" && factor.status !== "unverified"),
      )
    ) {
      throw new Error("Unusable factor response");
    }
    hasVerifiedFactor = data.factors.some(
      (factor) => factor.status === "verified",
    );
  } catch {
    // Do not expose provider error bodies, tokens, URLs, or credentials.
    throw new MfaPolicyError("unavailable");
  }

  if (hasVerifiedFactor) throw new MfaPolicyError("required");
}
