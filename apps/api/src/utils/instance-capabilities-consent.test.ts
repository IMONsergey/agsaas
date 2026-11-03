import { expect, test } from "bun:test";
import { getInstanceCapabilities } from "./instance-capabilities";
test("provider keys cannot enable an unverified bank consent flow", () => {
  const capability = getInstanceCapabilities({ PLAID_CLIENT_ID: "fixture", PLAID_SECRET: "fixture", TRIGGER_SECRET_KEY: "fixture" }).banking;
  expect(capability.enabled).toBe(false);
  expect(capability.reason).toContain("Verified bank consent");
});
