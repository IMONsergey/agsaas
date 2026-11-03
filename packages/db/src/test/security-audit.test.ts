import { describe, expect, test } from "bun:test";
import { securityAuditMetadata } from "../security-audit";

describe("security audit redaction", () => {
  test("records permission changes and operational status, never credentials or free text", () => {
    const result = securityAuditMetadata({
      beforeScopes: ["apis.read"],
      afterScopes: [
        "invoices.write",
        "secret@example.test",
        `unbounded ${"x".repeat(300)}`,
      ],
      scope: "others",
      count: 2,
      status: "pending",
      provider: "xero",
      accessToken: "private-secret-marker",
      refreshToken: "private-refresh-marker",
      email: "private@example.test",
      name: "Private Customer",
      input: { token: "nested-marker" },
      error: "provider secrets here",
    });
    expect(result).toEqual({
      beforeScopes: ["apis.read"],
      afterScopes: ["invoices.write"],
      scope: "others",
      count: 2,
      status: "pending",
      provider: "xero",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  test("metadata collection sizes and counters stay bounded", () => {
    const result = securityAuditMetadata({
      settingIds: Array.from({ length: 200 }, (_, i) => `setting_${i}`),
      count: Number.NaN,
      attempt: -1,
      status: { secret: "marker" },
    });
    expect(result.settingIds).toHaveLength(100);
    expect(result.count).toBeUndefined();
    expect(result.attempt).toBeUndefined();
    expect(result.status).toBeUndefined();
  });
});
