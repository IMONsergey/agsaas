import { describe, expect, test } from "bun:test";
import { toPublicApp } from "../public-app";
import { getApps } from "../queries/apps";
import type { Database } from "../client";

const secret = "fixture-private-credential-never-public";
const config = { access_token: secret, accessToken: secret, refreshToken: secret, token: secret,
  provider: "xero", tenantId: "org-1", tenantName: "Test Organization", team_name: "Test Workspace",
  connections: [{ userId: "123", username: "tester", phoneNumber: "15550000000", displayName: "Tester", accessToken: secret, nested: { secret } }],
  unknownFutureCredential: secret, nested: { secret } };

describe("public app DTO", () => {
  for (const appId of ["slack", "xero", "quickbooks", "fortnox", "telegram", "whatsapp", "sendblue", "future-provider"]) {
    test(`strips credentials and unreviewed nested fields for ${appId}`, () => {
      const result = toPublicApp({ appId, config, settings: [{ id: "receipts", value: true, unknown: secret }] });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.app_id).toBe(appId);
      expect(result.settings).toEqual([{ id: "receipts", value: true }]);
    });
  }
  test("preserves only UI metadata and never mutates the private record", () => {
    const result = toPublicApp({ appId: "xero", config });
    expect(result.config).toEqual({ provider: "xero", tenantId: "org-1", tenantName: "Test Organization" });
    expect(config.accessToken).toBe(secret);
    expect(toPublicApp({ appId: "future-provider", config }).config).toBeNull();
    expect(toPublicApp(null)).toBeNull();
  });
  test("the list query enforces the DTO even before a transport serializes it", async () => {
    const db = { select: () => ({ from: () => ({ where: async () => [{ app_id: "slack", settings: null, config }] }) }) } as unknown as Database;
    const result = await getApps(db, "fixture-team");
    expect(result).toEqual([{ app_id: "slack", settings: null, config: { team_name: "Test Workspace" } }]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
