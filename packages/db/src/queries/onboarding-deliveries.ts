import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";

export type OnboardingScope = { deliveryId: string; userId: string };
export type OnboardingStatus =
  | "pending"
  | "sending"
  | "accepted"
  | "canceled"
  | "rejected"
  | "reconciliation";
export type OnboardingContext =
  | { eligible: false; reason: string }
  | {
      eligible: true;
      recipient: string;
      fullName: string;
      teamId: string | null;
      hash: string;
    };
export type OnboardingDelivery = {
  id: string;
  userId: string;
  kind: "welcome" | "activation";
  status: OnboardingStatus;
  recipient: string | null;
  contextHash: string | null;
  envelope: string | null;
  envelopeHash: string | null;
  firstAttemptAt: string | null;
  context: OnboardingContext;
};
export type OnboardingClaim =
  | {
      state:
        | "busy"
        | "unprepared"
        | "accepted"
        | "canceled"
        | "rejected"
        | "reconciliation";
    }
  | {
      state: "claimed";
      leaseToken: string;
      envelope: string;
      envelopeHash: string;
      recipient: string;
    };
export type OnboardingOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "retry" | "rejected" | "reconciliation"; code: string };

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}
export async function listDueOnboarding(
  db: DatabaseOrTransaction,
  limit = 10,
): Promise<OnboardingScope[]> {
  const result = await primary(db).execute<{ id: string; user_id: string }>(
    sql`SELECT * FROM private.list_due_onboarding(${limit})`,
  );
  return result.rows.map((row) => ({
    deliveryId: row.id,
    userId: row.user_id,
  }));
}
export async function getOnboardingDelivery(
  db: DatabaseOrTransaction,
  scope: OnboardingScope,
) {
  const result = await primary(db).execute<{
    result: OnboardingDelivery | null;
  }>(
    sql`SELECT private.get_onboarding_delivery(${scope.deliveryId}::uuid,${scope.userId}::uuid) result`,
  );
  return result.rows[0]?.result ?? null;
}
export async function prepareOnboardingDelivery(
  db: DatabaseOrTransaction,
  scope: OnboardingScope,
  hash: string,
  envelope: string,
) {
  const result = await primary(db).execute<{ accepted: boolean }>(
    sql`SELECT private.prepare_onboarding_delivery(${scope.deliveryId}::uuid,${scope.userId}::uuid,${hash},${envelope}) accepted`,
  );
  return result.rows[0]?.accepted === true;
}
export async function claimOnboardingDelivery(
  db: DatabaseOrTransaction,
  scope: OnboardingScope,
): Promise<OnboardingClaim> {
  const result = await primary(db).execute<{ result: OnboardingClaim }>(
    sql`SELECT private.claim_onboarding_delivery(${scope.deliveryId}::uuid,${scope.userId}::uuid) result`,
  );
  return result.rows[0]?.result ?? { state: "canceled" };
}
export async function deferOnboardingDelivery(
  db: DatabaseOrTransaction,
  scope: OnboardingScope,
  reason: "configuration_unavailable" | "preparation_failed",
) {
  await primary(db).execute(
    sql`SELECT private.defer_onboarding_delivery(${scope.deliveryId}::uuid,${scope.userId}::uuid,${reason})`,
  );
}
export async function recordOnboardingOutcome(
  db: DatabaseOrTransaction,
  scope: OnboardingScope & { leaseToken: string },
  outcome: OnboardingOutcome,
): Promise<OnboardingStatus> {
  const result = await primary(db).execute<{ status: OnboardingStatus }>(
    sql`SELECT private.record_onboarding_outcome(${scope.deliveryId}::uuid,${scope.userId}::uuid,${scope.leaseToken}::uuid,${outcome.kind},${"code" in outcome ? outcome.code : null},${"messageId" in outcome ? outcome.messageId : null}) status`,
  );
  return result.rows[0]?.status ?? "canceled";
}
