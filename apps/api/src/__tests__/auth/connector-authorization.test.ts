import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DatabaseOrTransaction } from "@midday/db/client";

class TeamMembershipError extends Error {}
const reservation = {
  id: "33333333-3333-4333-8333-333333333333",
  teamId: "11111111-1111-4111-8111-111111111111",
  actorId: "22222222-2222-4222-8222-222222222222",
  entityId: "agsaas-team-11111111-1111-4111-8111-111111111111",
  toolkit: "gmail",
  providerAccountId: null,
  status: "pending" as const,
  createdAt: "2026-11-03",
  updatedAt: "2026-11-03",
};
let owner = true,
  currentStatus = "pending";
const reserve = mock(async (..._args: unknown[]) => ({
    ...reservation,
    created: true,
  })),
  attach = mock(async (..._args: unknown[]) => ({
    ...reservation,
    status: "active",
  }));
const audit = mock(async (..._args: unknown[]) => {});
mock.module("@midday/db/errors", () => ({ TeamMembershipError }));
mock.module("@midday/db/queries/security-audit", () => ({
  appendSecurityAuditEvent: audit,
}));
mock.module("@midday/db/queries/team-entitlements", () => ({
  reserveTeamConnector: reserve,
  attachTeamConnector: attach,
  listTeamConnectors: async () => [{ ...reservation, status: currentStatus }],
}));
mock.module("@midday/db/utils/team-membership", () => ({
  lockUserMembership: async () => {},
  lockTeamMembership: async () => [],
  requireTeamOwner: () => {
    if (!owner) throw new TeamMembershipError("demoted");
  },
}));
const { reserveOwnedTeamConnector, attachOwnedTeamConnector } = await import(
  "../../composio/authorizations"
);
const tx = {};
const db = {
  transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx),
} as unknown as DatabaseOrTransaction;

describe("connector authorization ownership fence", () => {
  beforeEach(() => {
    owner = true;
    currentStatus = "pending";
    reserve.mockClear();
    attach.mockClear();
    audit.mockClear();
  });
  test("a demoted actor cannot create the durable reservation preceding provider IO", async () => {
    owner = false;
    await expect(
      reserveOwnedTeamConnector(db, {
        teamId: reservation.teamId,
        actorId: reservation.actorId,
        toolkit: "gmail",
      }),
    ).rejects.toThrow("demoted");
    expect(reserve).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  test("reserve and authorization audit use the same transaction", async () => {
    expect(
      (
        await reserveOwnedTeamConnector(db, {
          teamId: reservation.teamId,
          actorId: reservation.actorId,
          toolkit: "gmail",
        })
      ).created,
    ).toBe(true);
    expect(reserve.mock.calls[0]?.[0]).toBe(tx);
    expect(audit.mock.calls[0]?.[0]).toBe(tx);
  });
  test("late completion after demotion or disconnect cannot activate the connector", async () => {
    owner = false;
    expect(
      await attachOwnedTeamConnector(db, reservation, "conn-fixture"),
    ).toBe(false);
    owner = true;
    currentStatus = "disconnecting";
    expect(
      await attachOwnedTeamConnector(db, reservation, "conn-fixture"),
    ).toBe(false);
    expect(attach).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  test("valid completion attaches and audits within the same transaction", async () => {
    expect(
      await attachOwnedTeamConnector(db, reservation, "conn-fixture"),
    ).toBe(true);
    expect(attach.mock.calls[0]?.[0]).toBe(tx);
    expect(audit.mock.calls[0]?.[0]).toBe(tx);
  });
});
