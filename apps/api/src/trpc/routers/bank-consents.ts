import { createHash } from "node:crypto";
import {
  completeHostedBankConsent,
  startHostedBankConsent,
} from "@api/services/hosted-bank-consent";
import {
  HostedPlaidUnavailableError,
  hostedPlaidCapability,
} from "@api/services/plaid-hosted-consent";
import { createTRPCRouter, ownerProcedure } from "@api/trpc/init";
import {
  BankConsentError,
  type HostedConsentActor,
} from "@midday/db/bank-consent";
import {
  cancelHostedBankConsent,
  getHostedBankConsent,
  hostedBankConsentView,
  listHostedBankConsents,
} from "@midday/db/queries/hosted-bank-consents";
import { TeamMembershipError } from "@midday/db/errors";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

const consentId = z.object({ id: z.string().uuid() }).strict();
const consentProcedure = ownerProcedure.use(({ ctx, next }) => {
  if (!ctx.teamId || !ctx.session.sessionId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in again to manage bank consent.",
    });
  }
  const bankConsentActor: HostedConsentActor = {
    teamId: ctx.teamId,
    userId: ctx.session.user.id,
    sessionId: ctx.session.sessionId,
    aal: ctx.session.aal ?? "aal1",
  };
  return next({ ctx: { bankConsentActor } });
});

/** SQL/provider failures can contain credentials in their details. Only these
 * redacted public failures cross this new browser-facing boundary. */
async function consentResult<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TeamMembershipError) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Current team ownership is required to manage bank consent.",
      });
    }
    if (error instanceof BankConsentError) {
      const failures = {
        not_found: {
          code: "NOT_FOUND",
          message: "This bank consent is unavailable for the current session.",
        },
        scope_changed: {
          code: "FORBIDDEN",
          message:
            "The account or installation has changed. Review the pending consent.",
        },
        session_expired: {
          code: "UNAUTHORIZED",
          message: "Sign in again and complete any required verification.",
        },
        pending_limit: {
          code: "TOO_MANY_REQUESTS",
          message:
            "Review your pending bank connections before starting another.",
        },
        quota_unavailable: {
          code: "PRECONDITION_FAILED",
          message: "The team's bank connection allowance is unavailable.",
        },
        provider_cleanup_pending: {
          code: "PRECONDITION_FAILED",
          message:
            "A previous bank consent needs cancellation or provider review before connecting again.",
        },
        invalid_provider_data: {
          code: "BAD_GATEWAY",
          message:
            "The bank provider returned data that could not be verified.",
        },
        connection_exists: {
          code: "CONFLICT",
          message: "This institution is already connected to the team.",
        },
        state_changed: {
          code: "CONFLICT",
          message:
            "The bank consent changed. Refresh its status before continuing.",
        },
      } as const;
      throw new TRPCError(failures[error.reason]);
    }
    if (error instanceof HostedPlaidUnavailableError) {
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: error.message,
      });
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Bank consent could not be confirmed. Refresh its status before continuing.",
    });
  }
}

/** Native consent is deliberately separate from the closed legacy token and
 * browser-selected account endpoints. Inputs contain no provider credentials. */
export const bankConsentsRouter = createTRPCRouter({
  capability: consentProcedure.query(({ ctx }) => ({
    ...hostedPlaidCapability(),
    // Opaque UI namespace only: never accepted as consent or authorization proof.
    // A new sign-in must not reuse an ambiguous command from the prior session.
    commandScope: createHash("sha256")
      .update(
        JSON.stringify([
          "agsaas-hosted-consent-ui:v1",
          ctx.bankConsentActor.teamId,
          ctx.bankConsentActor.userId,
          ctx.bankConsentActor.sessionId,
        ]),
      )
      .digest("hex"),
  })),
  list: consentProcedure.query(({ ctx }) =>
    consentResult(() => listHostedBankConsents(ctx.db, ctx.bankConsentActor)),
  ),
  get: consentProcedure
    .input(consentId)
    .query(({ ctx, input }) =>
      consentResult(async () =>
        hostedBankConsentView(
          await getHostedBankConsent(ctx.db, ctx.bankConsentActor, input.id),
          true,
        ),
      ),
    ),
  start: consentProcedure
    .input(
      z
        .object({ requestId: z.string().uuid(), country: z.enum(["US", "CA"]) })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      consentResult(() =>
        startHostedBankConsent(ctx.db, ctx.bankConsentActor, input),
      ),
    ),
  complete: consentProcedure
    .input(consentId)
    .mutation(({ ctx, input }) =>
      consentResult(() =>
        completeHostedBankConsent(ctx.db, ctx.bankConsentActor, input.id),
      ),
    ),
  cancel: consentProcedure
    .input(consentId)
    .mutation(({ ctx, input }) =>
      consentResult(async () =>
        hostedBankConsentView(
          await cancelHostedBankConsent(ctx.db, ctx.bankConsentActor, input.id),
        ),
      ),
    ),
});
