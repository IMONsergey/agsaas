import { afterAll, describe, expect, test } from "bun:test";
import {
  composioTeamEntityId,
  connectorCallbackUrl,
} from "../../composio/tenant";

const before = process.env.DASHBOARD_URL;
afterAll(() => {
  if (before === undefined) delete process.env.DASHBOARD_URL;
  else process.env.DASHBOARD_URL = before;
});
describe("connector tenant and redirect boundaries", () => {
  test("each team has a distinct explicit entity namespace", () => {
    const a = composioTeamEntityId("11111111-1111-4111-8111-111111111111"),
      b = composioTeamEntityId("22222222-2222-4222-8222-222222222222");
    expect(a).toBe("agsaas-team-11111111-1111-4111-8111-111111111111");
    expect(a).not.toBe(b);
    expect(() => composioTeamEntityId("attacker/../../team")).toThrow();
  });
  test("callback is pinned to this installation and cannot carry an arbitrary redirect", () => {
    process.env.DASHBOARD_URL = "https://dashboard.example.test";
    expect(connectorCallbackUrl()).toBe(
      "https://dashboard.example.test/connectors/callback",
    );
    expect(
      connectorCallbackUrl(
        "https://dashboard.example.test/connectors/callback",
      ),
    ).toBe("https://dashboard.example.test/connectors/callback");
    for (const url of [
      "https://attacker.example/callback",
      "https://dashboard.example.test/connectors/callback?next=https://attacker.example",
      "https://dashboard.example.test@attacker.example/connectors/callback",
    ])
      expect(() => connectorCallbackUrl(url)).toThrow();
  });
});
