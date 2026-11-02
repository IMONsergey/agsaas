import { describe, expect, mock, test } from "bun:test";
import {
  canStartAccountDeletion,
  getAccountDeletionErrorMessage,
  getAccountEntryRedirect,
  tryAccountDeletionSignOut,
} from "./account-deletion";

describe("account entry routing", () => {
  test.each([null, undefined])("missing user goes to login (%j)", (user) => {
    expect(getAccountEntryRedirect(user)).toBe("/login");
  });

  test.each([
    {},
    { fullName: "Fixture", teamId: null },
    { fullName: null, teamId: "team" },
    { fullName: "", teamId: "team" },
  ])("ordinary incomplete profiles still use onboarding (%j)", (user) => {
    expect(getAccountEntryRedirect(user)).toBe("/onboarding");
  });

  test("ordinary complete users keep the dashboard route", () => {
    expect(
      getAccountEntryRedirect({ fullName: "Fixture", teamId: "team" }),
    ).toBeNull();
    expect(
      getAccountEntryRedirect({
        fullName: "Fixture",
        teamId: "team",
        deletionStartedAt: null,
      }),
    ).toBeNull();
  });

  test.each([
    { fullName: null, teamId: null },
    { fullName: "Fixture", teamId: null },
    { fullName: "Fixture", teamId: "team" },
  ])("pending deletion wins over onboarding and dashboard (%j)", (user) => {
    expect(
      getAccountEntryRedirect({
        ...user,
        deletionStartedAt: "2026-10-31T10:00:00Z",
      }),
    ).toBe("/account-deletion");
  });

  test.each([
    "2000-01-01T00:00:00Z",
    "2099-01-01T00:00:00Z",
    "",
    "unexpected timestamp",
    new Date(0),
  ])("a persisted marker never expires or becomes onboarding in the browser (%j)", (deletionStartedAt) => {
    expect(
      getAccountEntryRedirect({
        fullName: null,
        teamId: null,
        deletionStartedAt,
      }),
    ).toBe("/account-deletion");
  });
});

describe("destructive confirmation and retry state", () => {
  test.each([
    "",
    "delete",
    "DELETE ",
    "Delete",
  ])("ordinary deletion still requires exact confirmation (%s)", (confirmation) => {
    expect(
      canStartAccountDeletion({
        pendingDeletion: false,
        confirmation,
        isBusy: false,
      }),
    ).toBe(false);
  });

  test("ordinary confirmed deletion is enabled", () => {
    expect(
      canStartAccountDeletion({
        pendingDeletion: false,
        confirmation: "DELETE",
        isBusy: false,
      }),
    ).toBe(true);
  });

  test("a server-confirmed pending request can be retried without new onboarding or typing", () => {
    expect(
      canStartAccountDeletion({
        pendingDeletion: true,
        confirmation: "",
        isBusy: false,
      }),
    ).toBe(true);
  });

  test.each([
    false,
    true,
  ])("in-flight requests cannot be submitted again (pending=%s)", (pendingDeletion) => {
    expect(
      canStartAccountDeletion({
        pendingDeletion,
        confirmation: "DELETE",
        isBusy: true,
      }),
    ).toBe(false);
  });

  test("a failed sign-out cannot trigger another deletion after confirmed success", () => {
    expect(
      canStartAccountDeletion({
        pendingDeletion: true,
        confirmation: "DELETE",
        isBusy: false,
        deletionConfirmed: true,
      }),
    ).toBe(false);
  });
});

describe("visible, safe deletion errors", () => {
  test("ownership rejection explains the available next step without provider details", () => {
    const message = getAccountDeletionErrorMessage(
      { data: { code: "FORBIDDEN" }, message: "private SQL detail" },
      false,
    );
    expect(message).toContain("transfer ownership");
    expect(message).not.toContain("private SQL detail");
  });

  test("unauthorized errors do not pretend deletion failed or succeeded", () => {
    const message = getAccountDeletionErrorMessage(
      { data: { code: "UNAUTHORIZED" } },
      true,
    );
    expect(message).toContain("may already have been deleted");
    expect(message).toContain("return to login");
    expect(
      getAccountDeletionErrorMessage({ code: "UNAUTHORIZED" }, false),
    ).toBe(message);
  });

  test.each([
    new Error("secret provider token"),
    "secret provider token",
    { message: "secret provider token" },
    null,
  ])("unknown errors use fixed recovery copy (%j)", (error) => {
    expect(getAccountDeletionErrorMessage(error, true)).toContain(
      "Retry deletion",
    );
    expect(getAccountDeletionErrorMessage(error, false)).toContain(
      "could not be confirmed",
    );
    expect(getAccountDeletionErrorMessage(error, true)).not.toContain(
      "secret provider token",
    );
    expect(getAccountDeletionErrorMessage(error, false)).not.toContain(
      "secret provider token",
    );
  });
});

describe("recovery sign-out", () => {
  test("uses local scope explicitly and accepts only an error-free result", async () => {
    const signOut = mock(async (_options: { scope: "local" }) => ({
      error: null,
    }));
    expect(await tryAccountDeletionSignOut(signOut)).toBe(true);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  test("a returned SDK failure remains a visible failure, not a successful logout", async () => {
    expect(
      await tryAccountDeletionSignOut(async () => ({
        error: new Error("fixture Auth failure"),
      })),
    ).toBe(false);
  });

  test("a rejected transport or client setup is handled without an unhandled rejection", async () => {
    expect(
      await tryAccountDeletionSignOut(async () => {
        throw new Error("fixture network failure");
      }),
    ).toBe(false);
  });

  test("does not report completion before the Auth operation settles", async () => {
    let resolve!: (result: { error: null }) => void;
    const operation = new Promise<{ error: null }>((done) => {
      resolve = done;
    });
    let completed = false;
    const result = tryAccountDeletionSignOut(() => operation).then((value) => {
      completed = true;
      return value;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    resolve({ error: null });
    expect(await result).toBe(true);
  });
});
