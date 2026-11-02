import { z } from "zod";

const cutoffSchema = z.iso.datetime({ offset: true });

export function isBlockedNewUser(createdAt: string | null | undefined) {
  // The upstream waitlist is opt-in. A fresh self-hosted installation must
  // not reject every account because of a historical hosted-service cutoff.
  const cutoff = process.env.NEW_USER_SIGNUP_CUTOFF?.trim();
  if (!cutoff) return false;

  if (!cutoffSchema.safeParse(cutoff).success) {
    throw new Error(
      "NEW_USER_SIGNUP_CUTOFF must be an ISO 8601 datetime with a timezone",
    );
  }

  if (!createdAt) return false;
  return Date.parse(createdAt) >= Date.parse(cutoff);
}
