import { describe, expect, test } from "bun:test";
import {
  isFreshPasswordRecovery,
  PASSWORD_RECOVERY_MAX_AGE_SECONDS,
} from "./password-policy";

const userId = "11111111-1111-4111-8111-111111111111";
const now = 1_800_000_000;
const claims = {
  sub: userId,
  role: "authenticated",
  aud: "authenticated",
  session_id: "22222222-2222-4222-8222-222222222222",
  exp: now + 3600,
  amr: [{ method: "recovery", timestamp: now }],
};

describe("verified password-recovery claim boundary", () => {
  test("accepts a fresh Auth recovery session before and after MFA", () => {
    expect(isFreshPasswordRecovery(claims, userId, now)).toBe(true);
    expect(
      isFreshPasswordRecovery(
        {
          ...claims,
          aal: "aal2",
          aud: ["authenticated"],
          amr: [...claims.amr, { method: "totp", timestamp: now }],
        },
        userId,
        now,
      ),
    ).toBe(true);
  });

  test.each([
    null,
    {},
    { ...claims, sub: "33333333-3333-4333-8333-333333333333" },
    { ...claims, role: "anon" },
    { ...claims, aud: "service_role" },
    { ...claims, session_id: "not-a-session" },
    { ...claims, exp: now },
    { ...claims, exp: String(now + 3600) },
    { ...claims, amr: [{ method: "password", timestamp: now }] },
    { ...claims, amr: [], user_metadata: { amr: claims.amr, recovery: true } },
    {
      ...claims,
      amr: [
        {
          method: "recovery",
          timestamp: now - PASSWORD_RECOVERY_MAX_AGE_SECONDS,
        },
      ],
    },
    { ...claims, amr: [{ method: "recovery", timestamp: now + 31 }] },
    { ...claims, amr: [{ method: "recovery", timestamp: String(now) }] },
    { ...claims, amr: [{ method: "recovery", timestamp: Number.NaN }] },
    { ...claims, amr: [{ method: "recovery", timestamp: now + 0.5 }] },
  ])("rejects an unrelated, expired or malformed recovery claim %#", (value) => {
    expect(isFreshPasswordRecovery(value, userId, now)).toBe(false);
  });
});
