import { describe, expect, test } from "bun:test";
import { readTeamQuotaError } from "./team-quota-error";

describe("safe quota error envelopes", () => {
  test("finds known nested SQL errors without disclosing query text", () => {
    const result = readTeamQuotaError({
      message: "private SQL with secret",
      cause: {
        message: "AGSAAS_QUOTA_EXCEEDED",
        detail: JSON.stringify({
          resource: "invoices",
          used: 6,
          limit: 5,
          resetsAt: "2026-12-01T00:00:00Z",
          private: "do not disclose",
        }),
      },
    });
    expect(result?.resource).toBe("invoices");
    expect(result?.used).toBe(6);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("disclose");
  });
  test("malformed or nonobject PostgreSQL detail does not break error handling", () => {
    for (const detail of ["null", "[]", "42", "bad json"]) {
      expect(
        readTeamQuotaError({ message: "AGSAAS_QUOTA_EXCEEDED", detail })
          ?.message,
      ).toContain("allowance");
    }
    expect(
      readTeamQuotaError({ message: "unrelated failure", detail: "private" }),
    ).toBeNull();
  });
});
