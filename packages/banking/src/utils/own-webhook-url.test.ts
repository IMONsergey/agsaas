import { expect, test } from "bun:test";
import { getBankWebhookUrl } from "./own-webhook-url";

test("bank callbacks use the configured own origin", () => {
  expect(
    getBankWebhookUrl("plaid", {
      API_URL: "https://94.249.186.240:8548",
      NODE_ENV: "production",
    }),
  ).toBe("https://94.249.186.240:8548/webhook/plaid");
  expect(
    getBankWebhookUrl("plaid", {
      API_URL: "http://localhost:8080",
      NODE_ENV: "development",
    }),
  ).toBe("http://localhost:8080/webhook/plaid");
});
test("bank callbacks reject missing, upstream, credentialed, insecure and path-bearing origins", () => {
  for (const value of [
    undefined,
    "https://api.midday.ai",
    "https://user:password@example.test",
    "http://example.test",
    "https://example.test/path",
    "https://example.test?query=1",
  ])
    expect(() =>
      getBankWebhookUrl("plaid", { API_URL: value, NODE_ENV: "production" }),
    ).toThrow();
});
