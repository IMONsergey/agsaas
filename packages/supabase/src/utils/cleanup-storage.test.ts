import { describe, expect, test } from "bun:test";
import { assertCleanupStoragePaths } from "../client/cleanup";

const teamId = "11111111-1111-4111-8111-111111111111",
  userId = "22222222-2222-4222-8222-222222222222";
describe("delete-only storage capability", () => {
  test("allows exactly retained namespaces", () => {
    expect(() =>
      assertCleanupStoragePaths({ teamId }, "vault", [`${teamId}/inbox/a.pdf`]),
    ).not.toThrow();
    expect(() =>
      assertCleanupStoragePaths({ teamId }, "apps", [`${teamId}/logos/a.png`]),
    ).not.toThrow();
    expect(() =>
      assertCleanupStoragePaths({ teamId }, "avatars", [
        `teams/${teamId}/logo/a.png`,
      ]),
    ).not.toThrow();
    expect(() =>
      assertCleanupStoragePaths({ userId }, "avatars", [
        `users/${userId}/a.png`,
      ]),
    ).not.toThrow();
  });
  test("rejects another tenant, cross-bucket/user paths and encoded traversal before IO", () => {
    for (const path of [
      `${userId}/a.pdf`,
      `${teamId}/../a.pdf`,
      `${teamId}/%2e%2e/a.pdf`,
      `${teamId}//a.pdf`,
      `${teamId}/a?b`,
      `${teamId}/a\\b`,
    ])
      expect(() =>
        assertCleanupStoragePaths({ teamId }, "vault", [path]),
      ).toThrow();
    expect(() =>
      assertCleanupStoragePaths({ teamId }, "avatars", [
        `users/${userId}/a.png`,
      ]),
    ).toThrow();
    expect(() =>
      assertCleanupStoragePaths({ userId }, "vault", [`${teamId}/a.pdf`]),
    ).toThrow();
    expect(() =>
      assertCleanupStoragePaths({ teamId }, "unknown", [`${teamId}/a.pdf`]),
    ).toThrow();
  });
  test("validates every batch item and caps each deletion request", () => {
    expect(() =>
      assertCleanupStoragePaths({ teamId }, "vault", [
        `${teamId}/good.pdf`,
        `${userId}/bad.pdf`,
      ]),
    ).toThrow();
    expect(() =>
      assertCleanupStoragePaths(
        { teamId },
        "vault",
        Array.from({ length: 101 }, () => `${teamId}/a.pdf`),
      ),
    ).toThrow();
  });
});
