import { describe, expect, test } from "bun:test";
import { TeamMembershipError } from "../errors";
import {
  requireAnotherOwner,
  requireTeamMember,
  requireTeamOwner,
  type TeamMembership,
} from "./team-membership";

const members: TeamMembership[] = [
  { userId: "owner", role: "owner" },
  { userId: "member", role: "member" },
];

describe("team membership invariants", () => {
  test("members are allowed ordinary membership operations", () => {
    expect(() => requireTeamMember(members, "member")).not.toThrow();
  });
  test("outsiders are not members", () => {
    expect(() => requireTeamMember(members, "outsider")).toThrow(
      TeamMembershipError,
    );
  });
  test("a member cannot act as owner", () => {
    expect(() => requireTeamOwner(members, "member")).toThrow(
      "Only team owners",
    );
  });
  test("the owner can act as owner", () => {
    expect(() => requireTeamOwner(members, "owner")).not.toThrow();
  });
  test("a last owner cannot leave even if ordinary members remain", () => {
    expect(() => requireAnotherOwner(members, "owner")).toThrow(
      "Transfer ownership",
    );
  });
  test("duplicate rows are not independent owners", () => {
    expect(() =>
      requireAnotherOwner([...members, members[0]!], "owner"),
    ).toThrow("Transfer ownership");
  });
  test("another distinct owner permits departure", () => {
    expect(() =>
      requireAnotherOwner(
        [...members, { userId: "other-owner", role: "owner" }],
        "owner",
      ),
    ).not.toThrow();
  });
  test("ordinary members may leave without owning the team", () => {
    expect(() => requireAnotherOwner(members, "member")).not.toThrow();
  });
});
