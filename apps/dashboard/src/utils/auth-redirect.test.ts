import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getAuthRedirectUrl } from "./auth-redirect";

const origin = "https://preview.example.test";

describe("authentication redirect destination", () => {
  for (const [input, expected] of [
    ["/settings/accounts", `${origin}/settings/accounts`],
    ["settings/accounts", `${origin}/settings/accounts`],
    [
      `${origin}/settings?tab=account#name`,
      `${origin}/settings?tab=account#name`,
    ],
    ["https://PREVIEW.example.test:443/teams", `${origin}/teams`],
    ["", `${origin}/`],
    ["/settings%2Faccounts", `${origin}/settings/accounts`],
  ]) {
    test(`accepts a same-origin destination (${input})`, () => {
      assert.equal(getAuthRedirectUrl(input!, origin), expected);
    });
  }

  for (const input of [
    "https://outside.example.test/",
    "http://preview.example.test/",
    "https://preview.example.test:444/",
    "https://user:secret@preview.example.test/",
    "//outside.example.test/",
    "//preview.example.test/",
    "\\\\outside.example.test/",
    "/\\outside.example.test/",
    "/%5coutside.example.test/",
    "/%2foutside.example.test/",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://preview.example.test@outside.example.test/",
    "/%0d%0aLocation:%20https://outside.example.test",
    "/settings\nanything",
    "/%ZZ",
  ]) {
    test(`rejects an unsafe destination (${JSON.stringify(input)})`, () => {
      assert.equal(getAuthRedirectUrl(input, origin), `${origin}/`);
    });
  }

  for (const invalid of [
    "javascript:alert(1)",
    "https://user:secret@preview.example.test",
    "https://preview.example.test?unexpected=1",
  ]) {
    test("invalid canonical URL fails without reflecting its value", () => {
      assert.throws(
        () => getAuthRedirectUrl("/", invalid),
        (error: unknown) => {
          assert(error instanceof Error);
          assert(!error.message.includes("secret"));
          assert(!error.message.includes("alert"));
          return true;
        },
      );
    });
  }
});
