/**
 * Counts describe email envelopes accepted by the provider, not delivery to an
 * inbox (and not the number of recipients in To/CC/BCC).
 */
export interface EmailDeliveryResult {
  sent: number;
  skipped: number;
  /** All envelopes without confirmed acceptance; includes uncertain outcomes. */
  failed: number;
  /** The provider may have accepted these despite a missing acknowledgement. */
  uncertain: number;
  /** True only when every failure is a confirmed, transient rejection. */
  retryable: boolean;
  providerMessageIds: string[];
  /** Time of the last confirmed provider acceptance, before activity writes. */
  acceptedAt?: string;
}

export function emptyEmailDeliveryResult(skipped = 0): EmailDeliveryResult {
  return {
    sent: 0,
    skipped,
    failed: 0,
    uncertain: 0,
    retryable: false,
    providerMessageIds: [],
  };
}

export function isEmailAccepted(result: EmailDeliveryResult): boolean {
  return (
    result.sent > 0 &&
    result.failed === 0 &&
    result.skipped === 0 &&
    result.uncertain === 0
  );
}

/** No provider payload, recipient or SDK error text is included in this error. */
export class EmailDeliveryError extends Error {
  readonly requiresReconciliation: boolean;
  readonly retryable: boolean;

  constructor(
    public readonly result: EmailDeliveryResult,
    public readonly phase: "delivery" | "activity" = "delivery",
  ) {
    const requiresReconciliation =
      phase === "activity" || result.sent > 0 || result.uncertain > 0;
    super(
      requiresReconciliation
        ? "Email acceptance needs reconciliation; automatic resend is unsafe"
        : "Email was not accepted by the provider",
    );
    this.name = "EmailDeliveryError";
    this.requiresReconciliation = requiresReconciliation;
    this.retryable = !requiresReconciliation && result.retryable;
  }
}

export function assertEmailAccepted(result: EmailDeliveryResult): void {
  if (!isEmailAccepted(result)) throw new EmailDeliveryError(result);
}
