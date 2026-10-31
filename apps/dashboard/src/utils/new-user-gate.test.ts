import { afterEach, describe, expect, test } from "bun:test";
import { isBlockedNewUser } from "./new-user-gate";

const originalCutoff = process.env.NEW_USER_SIGNUP_CUTOFF;

afterEach(() => {
  if (originalCutoff === undefined) {
    delete process.env.NEW_USER_SIGNUP_CUTOFF;
  } else {
    process.env.NEW_USER_SIGNUP_CUTOFF = originalCutoff;
  }
});

describe("self-hosted signup gate", () => {
  test("does not block fresh users when no cutoff is configured", () => {
    delete process.env.NEW_USER_SIGNUP_CUTOFF;
    expect(isBlockedNewUser("2026-04-20T00:00:00.000Z")).toBe(false);
    expect(isBlockedNewUser("2030-01-01T00:00:00.000Z")).toBe(false);
  });

  test.each([
    "",
    "   ",
  ])("an empty cutoff %j leaves registration open", (cutoff) => {
    process.env.NEW_USER_SIGNUP_CUTOFF = cutoff;
    expect(isBlockedNewUser("2030-01-01T00:00:00.000Z")).toBe(false);
  });

  test("an explicit cutoff preserves the inclusive hosted waitlist behavior", () => {
    process.env.NEW_USER_SIGNUP_CUTOFF = "2026-04-20T00:00:00.000Z";
    expect(isBlockedNewUser("2026-04-19T23:59:59.999Z")).toBe(false);
    expect(isBlockedNewUser("2026-04-20T00:00:00.000Z")).toBe(true);
    expect(isBlockedNewUser("2030-01-01T00:00:00.000Z")).toBe(true);
  });

  test("compares instants, including explicit timezone offsets", () => {
    process.env.NEW_USER_SIGNUP_CUTOFF = " 2026-04-20T03:00:00+03:00 ";
    expect(isBlockedNewUser("2026-04-19T23:59:59.999Z")).toBe(false);
    expect(isBlockedNewUser("2026-04-20T00:00:00.000Z")).toBe(true);
  });

  test.each([
    "not-a-date",
    "2026-04-20",
    "2026-04-20T00:00:00",
    "2026-02-30T00:00:00Z",
  ])("rejects invalid configured cutoff %j instead of silently disabling the gate", (cutoff) => {
    process.env.NEW_USER_SIGNUP_CUTOFF = cutoff;
    expect(() => isBlockedNewUser("2030-01-01T00:00:00Z")).toThrow(
      "NEW_USER_SIGNUP_CUTOFF must be an ISO 8601 datetime with a timezone",
    );
  });

  test("missing or malformed user timestamps do not turn anonymous visits into waitlist notices", () => {
    process.env.NEW_USER_SIGNUP_CUTOFF = "2026-04-20T00:00:00.000Z";
    expect(isBlockedNewUser(undefined)).toBe(false);
    expect(isBlockedNewUser(null)).toBe(false);
    expect(isBlockedNewUser("invalid-user-date")).toBe(false);
  });
});
