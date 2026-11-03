import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "@midday/db/client";

class TeamOwnerRequiredError extends Error {}
let error: Error | null = null;
const requireTeamOwner = mock(async () => {
  if (error) throw error;
});
mock.module("@api/utils/team-owner", () => ({
  requireTeamOwner,
  TeamOwnerRequiredError,
}));
const { resolveSecurityAuditScope } = await import(
  "../../utils/security-audit-scope"
);

describe("security journal visibility", () => {
  const db = {} as Database;
  const input = {
    teamId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "22222222-2222-4222-8222-222222222222",
  };
  beforeEach(() => {
    error = null;
    requireTeamOwner.mockClear();
  });
  test("owner can read the team journal and own global account events", async () => {
    expect(await resolveSecurityAuditScope(db, input)).toEqual(input);
    expect(requireTeamOwner).toHaveBeenCalledWith(
      db,
      input.teamId,
      input.actorUserId,
    );
  });
  test("nonowner is restricted to own global account events", async () => {
    error = new TeamOwnerRequiredError();
    expect(await resolveSecurityAuditScope(db, input)).toEqual({
      teamId: null,
      actorUserId: input.actorUserId,
    });
  });
  test("a user without a selected team can still read own account events", async () => {
    expect(
      await resolveSecurityAuditScope(db, { actorUserId: input.actorUserId }),
    ).toEqual({ teamId: null, actorUserId: input.actorUserId });
    expect(requireTeamOwner).not.toHaveBeenCalled();
  });
  test("unexpected authorization failures do not silently grant any scope", async () => {
    error = new Error("database unavailable");
    await expect(resolveSecurityAuditScope(db, input)).rejects.toThrow(
      "database unavailable",
    );
  });
});
