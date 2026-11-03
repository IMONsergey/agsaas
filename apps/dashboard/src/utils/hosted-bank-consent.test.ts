import { describe, expect, test } from "bun:test";
import {
  bankConsentId,
  hostedBankConsentPresentation,
  hostedBankNavigationUrl,
  hostedBankConsentStorageKey,
  hostedBankConsentError,
  pendingHostedConsentCommand,
} from "./hosted-bank-consent";

const id = "6c758b21-2fe9-4d6a-b645-f68f2c14b4ef";
const connectionId = "27db5684-865c-4379-a38e-7fa770652375";
const url = "https://secure.plaid.com/hl/fixture-consent";
const row = { id, status: "awaiting_consent", connectionId: null, url };

describe("native bank consent UI evidence", () => {
  test("a new sign-in namespace cannot recover the prior session's uncertain command", () => {
    const oldKey = hostedBankConsentStorageKey("a".repeat(64));
    const currentKey = hostedBankConsentStorageKey("b".repeat(64));
    expect(oldKey).not.toBe(currentKey);
    const storage = new Map([
      [oldKey, JSON.stringify({ requestId: id, country: "US" })],
    ]);
    expect(
      pendingHostedConsentCommand(storage.get(currentKey) ?? null),
    ).toBeNull();
    expect(
      pendingHostedConsentCommand(storage.get(oldKey) ?? null)?.requestId,
    ).toBe(id);
    for (const value of [
      undefined,
      null,
      "",
      "old-session-id",
      id,
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
    ]) {
      expect(hostedBankConsentStorageKey(value)).toBeNull();
    }
  });
  test("only a completed server record with a connection identity is accepted", () => {
    for (const status of [
      "creating",
      "awaiting_consent",
      "exchanging",
      "grant_received",
      "verified",
      "cleanup_requested",
      "cleanup_pending",
      "canceled",
      "reconciliation",
      "unexpected",
    ]) {
      expect(
        hostedBankConsentPresentation({ ...row, status, connectionId })
          .accepted,
      ).toBe(false);
    }
    expect(
      hostedBankConsentPresentation({
        ...row,
        status: "completed",
        connectionId,
      }),
    ).toMatchObject({
      accepted: true,
      terminal: true,
      canVerify: false,
      canOpen: false,
    });
    expect(
      hostedBankConsentPresentation({ ...row, status: "completed" }).accepted,
    ).toBe(false);
  });
  test("unknown provider outcomes cannot be retried or reported as canceled", () => {
    expect(
      hostedBankConsentPresentation({ ...row, status: "reconciliation" }),
    ).toMatchObject({
      accepted: false,
      terminal: false,
      needsReview: true,
      canVerify: false,
      canCancel: false,
      canOpen: false,
    });
    for (const status of ["cleanup_requested", "cleanup_pending"]) {
      expect(hostedBankConsentPresentation({ ...row, status })).toMatchObject({
        terminal: false,
        accepted: false,
        canVerify: false,
        canCancel: false,
        title: "Cancellation pending",
      });
    }
    expect(
      hostedBankConsentPresentation({ ...row, status: "canceled" }),
    ).toMatchObject({
      terminal: true,
      accepted: false,
      title: "Cancellation confirmed",
    });
  });
  test("an in-flight exchange offers no second verification command", () => {
    expect(
      hostedBankConsentPresentation({ ...row, status: "exchanging" }),
    ).toMatchObject({ canOpen: false, canVerify: false, accepted: false });
    for (const status of ["grant_received", "verified"]) {
      expect(hostedBankConsentPresentation({ ...row, status })).toMatchObject({
        canVerify: true,
        accepted: false,
      });
    }
  });
  test("a missing or unsafe hosted URL cannot resume an expired consent", () => {
    expect(
      hostedBankConsentPresentation({ ...row, url: undefined }),
    ).toMatchObject({ canOpen: false, canVerify: false, canCancel: true });
    expect(
      hostedBankConsentPresentation({
        ...row,
        url: "https://foreign.example.test/",
      }),
    ).toMatchObject({ canOpen: false, canVerify: false, accepted: false });
  });
  test("a redirect reference is only an internal UUID, never provider evidence", () => {
    expect(bankConsentId(id)).toBe(id);
    for (const value of [
      null,
      undefined,
      "",
      "public-sandbox-token",
      "item_provider_id",
      "https://secure.plaid.com/",
      `${id}?accepted=true`,
    ])
      expect(bankConsentId(value)).toBeNull();
    expect(
      hostedBankConsentPresentation({
        ...row,
        id: "provider-item",
        status: "completed",
        connectionId,
      }).accepted,
    ).toBe(false);
  });
  test("navigation accepts only HTTPS on the fixed Plaid host", () => {
    expect(hostedBankNavigationUrl(url)).toBe(url);
    for (const value of [
      null,
      "javascript:alert(1)",
      "file:///etc/passwd",
      "/relative",
      "http://secure.plaid.com/hl/id",
      "https://secure.plaid.com.evil.test/",
      "https://secure.plaid.com@evil.test/",
      "https://evil@secure.plaid.com/",
      "https://secure.plaid.com:444/",
      `${url}#fragment`,
      `${url}\n`,
      `${url}\u007f`,
    ])
      expect(hostedBankNavigationUrl(value)).toBeNull();
  });
  test("only a bounded internal command can be recovered from browser storage", () => {
    const command = { requestId: id, country: "CA" };
    expect(pendingHostedConsentCommand(JSON.stringify(command))).toEqual(
      command,
    );
    for (const value of [
      null,
      "",
      "not json",
      "[]",
      JSON.stringify({ requestId: "public-sandbox-token", country: "US" }),
      JSON.stringify({ ...command, country: "GB" }),
      JSON.stringify({ ...command, accepted: true }),
      JSON.stringify({ ...command, access_token: "provider-token" }),
      JSON.stringify({ requestId: id }),
    ]) {
      expect(pendingHostedConsentCommand(value)).toBeNull();
    }
  });
  test("provider or SQL exception details are never rendered to the browser", () => {
    for (const error of [
      new Error("access-sandbox-secret"),
      {
        message: "encrypted_payload=secret",
        data: { code: "INTERNAL_SERVER_ERROR" },
      },
      { data: "secret" },
    ]) {
      expect(hostedBankConsentError(error)).toBe(
        "The request could not be confirmed. Refresh its status before continuing.",
      );
    }
    expect(hostedBankConsentError({ data: { code: "FORBIDDEN" } })).toContain(
      "current team owner",
    );
    expect(
      hostedBankConsentError({ data: { code: "UNAUTHORIZED" } }),
    ).toContain("Sign in again");
  });
});
