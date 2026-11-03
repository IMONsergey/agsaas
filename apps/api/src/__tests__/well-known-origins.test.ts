import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { wellKnownRouter } from "../rest/routers/well-known";

const keys = [
  "NODE_ENV",
  "API_URL",
  "MIDDAY_API_URL",
  "NEXT_PUBLIC_API_URL",
  "DASHBOARD_URL",
  "MIDDAY_DASHBOARD_URL",
  "NEXT_PUBLIC_URL",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const api = "https://api.agsaas.example.test:8548";
const dashboard = "https://dashboard.agsaas.example.test:8547";
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.NODE_ENV = "production";
  process.env.API_URL = api;
  process.env.DASHBOARD_URL = dashboard;
});
afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
describe("OAuth discovery belongs to the installation", () => {
  test.each([
    "/oauth-protected-resource",
    "/oauth-protected-resource/mcp",
  ])("uses the own origin and port at %s", async (path) => {
    const response = await wellKnownRouter.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: api,
      authorization_servers: [api],
      resource_documentation: `${api}/`,
    });
  });
  test("every authorization endpoint identifies the own API or dashboard", async () => {
    const response = await wellKnownRouter.request(
      "/oauth-authorization-server",
    );
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata).toMatchObject({
      issuer: api,
      authorization_endpoint: `${dashboard}/oauth/authorize`,
      token_endpoint: `${api}/oauth/token`,
      registration_endpoint: `${api}/oauth/register`,
      revocation_endpoint: `${api}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(JSON.stringify(metadata)).not.toContain("midday.ai");
  });
  test.each([
    "https://api.midday.ai",
    "https://user:secret@api.example.test",
    "https://api.example.test/path",
    "",
  ])("fails closed instead of advertising an invalid production API origin", async (origin) => {
    process.env.API_URL = origin;
    const response = await wellKnownRouter.request(
      "/oauth-authorization-server",
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });
});
