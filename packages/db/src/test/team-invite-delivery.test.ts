import { describe, expect, test } from "bun:test";
import {
  teamInviteEnvelopeHash,
  validateTeamInviteEnvelope,
} from "../team-invite-delivery";

const envelope = JSON.stringify({
  from: "AGSaaS <hello@example.test>",
  to: ["recipient@example.test"],
  subject: "Invitation",
  html: "<p>Join the team</p>",
});

describe("invitation persisted envelope boundary", () => {
  test("accepts exact stored bytes for the authoritative recipient", () => {
    expect(() =>
      validateTeamInviteEnvelope(
        envelope,
        teamInviteEnvelopeHash(envelope),
        "recipient@example.test",
      ),
    ).not.toThrow();
  });
  test("rejects altered bytes before a provider request", () => {
    expect(() =>
      validateTeamInviteEnvelope(
        `${envelope} `,
        teamInviteEnvelopeHash(envelope),
        "recipient@example.test",
      ),
    ).toThrow();
  });
  test("rejects a valid hash belonging to another recipient", () => {
    expect(() =>
      validateTeamInviteEnvelope(
        envelope,
        teamInviteEnvelopeHash(envelope),
        "other@example.test",
      ),
    ).toThrow();
  });
  test("rejects a second recipient in a persisted envelope", () => {
    const body = JSON.stringify({
      ...JSON.parse(envelope),
      to: ["recipient@example.test", "other@example.test"],
    });
    expect(() =>
      validateTeamInviteEnvelope(
        body,
        teamInviteEnvelopeHash(body),
        "recipient@example.test",
      ),
    ).toThrow();
  });
  test("rejects oversized, malformed and header-injected messages", () => {
    for (const body of [
      "invalid",
      JSON.stringify({ ...JSON.parse(envelope), html: "x".repeat(131073) }),
      JSON.stringify({
        ...JSON.parse(envelope),
        subject: "Invitation\r\nBcc: other@example.test",
      }),
    ]) {
      expect(() =>
        validateTeamInviteEnvelope(
          body,
          teamInviteEnvelopeHash(body),
          "recipient@example.test",
        ),
      ).toThrow();
    }
  });
});
