/** Generic mail has no provider-durable frozen envelope. An interrupted external
 * dispatch therefore stops for reconciliation instead of being blindly replayed. */
export type NotificationDispatchStatus =
  | "pending"
  | "dispatching"
  | "completed"
  | "rejected"
  | "reconciliation";

export type NotificationDispatchKind =
  | "notification"
  | "payment-issue"
  | "recurring-upcoming";

export type NotificationDispatchOutcome = {
  activities: number;
  sent: number;
  skipped: number;
  failed: number;
  uncertain: number;
  retryable: boolean;
  providerMessageIds: string[];
  reason?: "configuration_unavailable" | "preparation_failed";
};

export const NOTIFICATION_DISPATCH_LEASE_SECONDS = 300;
export const NOTIFICATION_DISPATCH_MAX_ATTEMPTS = 12;
export const NOTIFICATION_DISPATCH_MAX_PAYLOAD_BYTES = 256 * 1024;
