import { createHash } from "node:crypto";

export type TeamInviteDeliveryState =
  | "pending"
  | "sending"
  | "accepted"
  | "reconciliation"
  | "canceled"
  | "rejected";
export type TeamInviteEmailContext = {
  invitedByName: string;
  invitedByEmail: string;
  teamName: string;
  locale: string;
  ip?: string;
};
export type TeamInviteDeliveryScope = {
  teamId: string;
  inviteId: string;
  deliveryId: string;
};

// Same provider replay contract as durable invoice mail. Each replay reuses
// exact persisted bytes and key; no SMTP exactly-once guarantee is implied.
export const TEAM_INVITE_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const TEAM_INVITE_LEASE_SECONDS = 120;
export const TEAM_INVITE_MAX_ATTEMPTS = 12;
export const TEAM_INVITE_ENVELOPE_MAX_BYTES = 128 * 1024;

export function teamInviteEnvelopeHash(envelope: string): string {
  return createHash("sha256").update(envelope).digest("hex");
}

export function validateTeamInviteEnvelope(
  envelope: string,
  hash: string,
  recipient: string,
): void {
  if (
    Buffer.byteLength(envelope, "utf8") > TEAM_INVITE_ENVELOPE_MAX_BYTES ||
    teamInviteEnvelopeHash(envelope) !== hash
  ) {
    throw new Error("Invitation email envelope integrity check failed");
  }
  let body: unknown;
  try {
    body = JSON.parse(envelope);
  } catch {
    throw new Error("Invalid invitation email envelope");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid invitation email envelope");
  const value = body as Record<string, unknown>;
  if (
    !Array.isArray(value.to) ||
    value.to.length !== 1 ||
    value.to[0] !== recipient ||
    typeof value.from !== "string" ||
    !value.from.trim() ||
    /[\r\n]/.test(value.from) ||
    typeof value.subject !== "string" ||
    !value.subject.trim() ||
    value.subject.length > 512 ||
    /[\r\n]/.test(value.subject) ||
    typeof value.html !== "string" ||
    !value.html.trim() ||
    "cc" in value ||
    "bcc" in value ||
    "attachments" in value
  ) {
    throw new Error("Invalid invitation email envelope");
  }
}
