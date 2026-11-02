import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEnabledAuthProviders, selectSignInOptions } from "./auth-methods";

describe("configured sign-in methods", () => {
  for (const value of [undefined, "", "  "]) {
    test(`missing configuration enables only email (${JSON.stringify(value)})`, () => {
      assert.deepEqual(parseEnabledAuthProviders(value), ["email"]);
    });
  }

  test("password requires an explicit configuration entry", () => {
    assert.deepEqual(parseEnabledAuthProviders("password"), ["password"]);
    assert.deepEqual(parseEnabledAuthProviders("email, password, github"), [
      "email",
      "password",
      "github",
    ]);
  });

  test("supports exactly the named provider set without adding providers", () => {
    assert.deepEqual(
      parseEnabledAuthProviders("email,password,google,apple,azure,github"),
      ["email", "password", "google", "apple", "azure", "github"],
    );
  });

  for (const invalid of [
    "*",
    "Google",
    "otp",
    "email,",
    ",password",
    "email,,github",
    "email,email",
    "saml",
    "password,private-provider-secret",
  ]) {
    test(`rejects an unsupported or ambiguous configuration (${invalid.split(",")[0]})`, () => {
      assert.throws(
        () => parseEnabledAuthProviders(invalid),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /AUTH_ENABLED_PROVIDERS/);
          assert(!error.message.includes("private-provider-secret"));
          return true;
        },
      );
    });
  }

  test("a stale OAuth cookie cannot enable a disabled provider", () => {
    assert.deepEqual(selectSignInOptions(["email"], "google"), {
      primary: "email",
      alternatives: [],
    });
    assert.deepEqual(selectSignInOptions(["password"], "otp"), {
      primary: "password",
      alternatives: [],
    });
  });

  test("preserves a valid preference and maps the existing OTP cookie to email", () => {
    assert.deepEqual(
      selectSignInOptions(["password", "email", "github"], "otp"),
      {
        primary: "email",
        alternatives: ["password", "github"],
      },
    );
    assert.deepEqual(selectSignInOptions(["email", "github"], "github"), {
      primary: "github",
      alternatives: ["email"],
    });
  });

  test("invalid preferences do not affect the configured default", () => {
    assert.deepEqual(selectSignInOptions(["password", "email"], "<script>"), {
      primary: "password",
      alternatives: ["email"],
    });
  });

  test("selection does not mutate the caller's configured list", () => {
    const methods = Object.freeze(["email", "github"] as const);
    selectSignInOptions(methods, "github");
    assert.deepEqual(methods, ["email", "github"]);
  });
});
