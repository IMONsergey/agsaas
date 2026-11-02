export const BANK_CLEANUP_MAX_ATTEMPTS = 12;
export const BANK_CLEANUP_LEASE_SECONDS = 120;

export type BankCleanupProvider =
  | "plaid"
  | "gocardless"
  | "teller"
  | "enablebanking";
export type BankCleanupTarget = {
  provider: BankCleanupProvider | null;
  referenceId: string | null;
  accessToken: string | null;
};
export type BankCleanupOutcome =
  | { status: "completed"; reason: "revoked" | "already_absent" }
  | { status: "pending"; reason: "provider_rate_limit" }
  | {
      status: "reconciliation";
      reason:
        | "provider_rejected"
        | "provider_uncertain"
        | "provider_identity_missing";
    };
