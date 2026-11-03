import { createHash, timingSafeEqual } from "node:crypto";
export function isSupportIngestAuthorized(
  received: string | undefined,
  expected: string | undefined,
) {
  if (!expected || expected.length < 32 || !received || received.length > 256)
    return false;
  return timingSafeEqual(
    createHash("sha256").update(received).digest(),
    createHash("sha256").update(`Bearer ${expected}`).digest(),
  );
}
