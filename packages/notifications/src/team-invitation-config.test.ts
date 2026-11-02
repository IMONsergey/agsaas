import { describe, expect, test } from "bun:test";
import { getTeamInviteEmailConfig } from "./services/team-invitation-config";

const valid = {
  RESEND_API_KEY: "test-key",
  EMAIL_FROM: "AGSaaS <hello@example.test>",
  DASHBOARD_URL: "https://app.example.test",
  APP_NAME: "AGSaaS",
};
describe("self-hosted invitation email configuration", () => {
  test("uses the instance sender and exact dashboard origin", () => {
    expect(getTeamInviteEmailConfig(valid)).toEqual({
      from: "AGSaaS <hello@example.test>",
      appUrl: "https://app.example.test",
      productName: "AGSaaS",
    });
  });
  test("does not substitute upstream domains or a missing provider", () => {
    for (const patch of [
      { RESEND_API_KEY: "" },
      { EMAIL_FROM: "" },
      { EMAIL_FROM: "Midday <middaybot@midday.ai>" },
      { DASHBOARD_URL: "" },
      { DASHBOARD_URL: "https://app.midday.ai" },
    ]) {
      expect(() => getTeamInviteEmailConfig({ ...valid, ...patch })).toThrow(
        "Invitation email is not configured",
      );
    }
  });
  test("rejects non-origin URLs, credentials and header injection", () => {
    for (const patch of [
      { DASHBOARD_URL: "https://user:password@app.example.test" },
      { DASHBOARD_URL: "https://app.example.test/path" },
      { DASHBOARD_URL: "https://app.example.test?redirect=other" },
      { DASHBOARD_URL: "http://app.example.test" },
      { EMAIL_FROM: "hello@example.test\r\nBcc:other@example.test" },
      { APP_NAME: "App\nInjected" },
    ]) {
      expect(() => getTeamInviteEmailConfig({ ...valid, ...patch })).toThrow(
        "Invitation email is not configured",
      );
    }
  });
  test("permits isolated loopback fixtures and strips the trailing slash", () => {
    expect(
      getTeamInviteEmailConfig({
        ...valid,
        DASHBOARD_URL: "http://127.0.0.1:13000/",
      }).appUrl,
    ).toBe("http://127.0.0.1:13000");
  });
});
