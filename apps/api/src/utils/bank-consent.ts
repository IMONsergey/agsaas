import type { Session } from "@api/utils/auth";
import { requireTeamOwner, TeamOwnerRequiredError } from "@api/utils/team-owner";
import type { Database } from "@midday/db/client";
import { getBankConnections } from "@midday/db/queries";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import type { getProviderAccountsSchema } from "@api/schemas/banking";

export { BANK_CONSENT_ONBOARDING_READY } from "./bank-consent-policy";
/** No environment switch may bypass the missing persisted consent lifecycle. */
export function requireVerifiedBankConsent(): void {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Bank connections require a verified consent flow, which is not yet configured for this instance. Manual accounts remain available." });
}

export async function resolveProviderAccountAccess(
  ctx: { db: Database; teamId?: string | null; session?: Session | null; isInternalRequest?: boolean },
  input: z.infer<typeof getProviderAccountsSchema>,
) {
  if (ctx.isInternalRequest) return input;
  if (!ctx.session || !ctx.teamId) throw new TRPCError({ code: "FORBIDDEN", message: "Team access required" });
  try { await requireTeamOwner(ctx.db, ctx.teamId, ctx.session.user.id); }
  catch (error) {
    if (error instanceof TeamOwnerRequiredError) throw new TRPCError({ code: "FORBIDDEN", message: error.message });
    throw error;
  }
  if (!input.connectionId) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An owned, verified bank connection is required" });
  }
  const primary = ctx.db.usePrimaryOnly ? ctx.db.usePrimaryOnly() : ctx.db;
  const owned = (await getBankConnections(primary, { teamId: ctx.teamId })).find((connection) => connection.id === input.connectionId);
  if (!owned || owned.provider !== input.provider) throw new TRPCError({ code: "NOT_FOUND", message: "Bank connection not found" });
  if (owned.status !== "connected") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Bank connection is not active" });
  // Browser-supplied provider references and access tokens never reach the SDK.
  return { provider: input.provider, id: (owned.provider === "teller" ? owned.enrollmentId : owned.referenceId) ?? undefined, accessToken: owned.accessToken ?? undefined, institutionId: owned.institutionId ?? undefined };
}
