/** Persisted, server-only envelope contract. Never include this payload in logs. */
export type InvoiceEmailDeliveryKind = "invoice" | "reminder";

export type InvoiceEmailDeliveryState =
  | "pending"
  | "sending"
  | "accepted"
  | "completed"
  | "reconciliation"
  | "canceled"
  | "rejected";

export type InvoiceEmailActivity = {
  userId: string;
  priority: number;
  metadata: Record<string, unknown>;
};

// Resend currently retains idempotency keys for 24h. Stop replay a full hour
// earlier, measured from the DB timestamp BEFORE the first HTTP attempt.
export const INVOICE_EMAIL_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const INVOICE_EMAIL_ENVELOPE_MAX_BYTES = 4 * 1024 * 1024;
export const INVOICE_EMAIL_LEASE_SECONDS = 120;
export const INVOICE_EMAIL_MAX_ATTEMPTS = 12;
