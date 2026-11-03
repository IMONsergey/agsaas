import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Context } from "@api/rest/types";
import type { Database } from "@midday/db/client";
import { TeamMembershipError } from "@midday/db/errors";
import type { CreateIntegrationOAuthIntentParams, IntegrationOAuthIntent } from "@midday/db/queries";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

const userId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const api = "https://api.example.test";
const dashboard = "https://app.example.test";
const db = {} as Database;
let authType: "session" | "api-key" | "oauth" = "session";
let owner = true;
let verifiedFactor = false;
let revokeDuringExchange = false;
type Stored = CreateIntegrationOAuthIntentParams & { id: string; expires: number; consumed: boolean; complete: boolean };
const records = new Map<string, Stored>();
const envKeys = ["API_URL", "DASHBOARD_URL", "XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_OAUTH_REDIRECT_URL"];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const createIntent = mock(async (_db: Database, params: CreateIntegrationOAuthIntentParams) => {
  if (!owner) throw new TeamMembershipError("TEAM_OWNER_REQUIRED");
  const record = { ...params, id: randomUUID(), expires: Date.now() + 600_000, consumed: false, complete: false };
  records.set(params.stateHash, record); return { id: record.id };
});
function find(params: Pick<CreateIntegrationOAuthIntentParams, "stateHash" | "browserNonceHash" | "provider">) {
  const r = records.get(params.stateHash);
  return r && r.browserNonceHash === params.browserNonceHash && r.provider === params.provider && r.expires > Date.now() && !r.consumed ? r : null;
}
const consumeIntent = mock(async (_db: Database, params: Pick<CreateIntegrationOAuthIntentParams, "stateHash" | "browserNonceHash" | "provider">) => {
  const record = find(params);
  if (!record || !owner) return null;
  record.consumed = true; return record;
});
const persist = mock(async () => ({ id: "app-fixture" }));
const exchange = mock(async () => {
  if (revokeDuringExchange) owner = false;
  return { accessToken: "private-access-marker", refreshToken: "private-refresh-marker", expiresAt: new Date(), tenantId: "tenant-fixture", tenantName: "Fixture" };
});
const listFactors = mock(async () => ({ data: { factors: verifiedFactor ? [{ status: "verified" }] : [] }, error: null }));
mock.module("@api/services/supabase", () => ({ createAdminClient: async () => ({ auth: { admin: { mfa: { listFactors } } } }) }));
mock.module("@midday/db/queries", () => ({
  createIntegrationOAuthIntent: createIntent,
  findIntegrationOAuthIntent: async (_db: Database, params: Pick<CreateIntegrationOAuthIntentParams, "stateHash" | "browserNonceHash" | "provider">) => find(params),
  consumeIntegrationOAuthIntent: consumeIntent,
  completeIntegrationOAuthIntent: async (_db: Database, intent: IntegrationOAuthIntent, write: (tx: Database) => Promise<unknown>) => {
    if (!owner) throw new TeamMembershipError("TEAM_OWNER_REQUIRED");
    const record = [...records.values()].find(r => r.id === intent.id);
    if (!record?.consumed || record.complete) throw new Error("Invalid intent");
    const result = await write(db); record.complete = true; return result;
  },
  createApp: persist,
}));
mock.module("@midday/accounting", () => ({
  XERO_SCOPES: ["fixture"],
  getAccountingProvider: () => ({ buildConsentUrl: async (state: string) => `https://provider.example.test/authorize?state=${state}`, exchangeCodeForTokens: exchange }),
}));
mock.module("@midday/logger", () => ({ logger: { info() {}, warn() {}, error() {} } }));
const attach: MiddlewareHandler<Context> = async (c, next) => {
  c.set("db", db); c.set("teamId", teamId); c.set("authType", authType);
  c.set("session", { user: { id: userId }, teamId, aal: authType === "session" ? "aal1" : undefined });
  await next();
};
mock.module("@api/rest/middleware", () => ({ protectedMiddleware: [attach], publicMiddleware: [attach] }));
const { installUrlRouter } = await import("../../rest/routers/apps/xero/install-url");
const { oauthCallbackRouter } = await import("../../rest/routers/apps/xero/oauth-callback");
function app() {
  const result = new Hono<Context>();
  result.route("/apps/xero/install-url", installUrlRouter);
  result.route("/apps/xero/oauth-callback", oauthCallbackRouter);
  result.onError((e, c) => e instanceof HTTPException ? e.getResponse() : c.json({ error: "Request failed" }, 500));
  return result;
}
async function start() {
  const response = await app().request(`${api}/apps/xero/install-url`, { method: "POST" });
  const body = response.status === 200 ? await response.json() as { url: string } : null;
  return { response, state: body ? new URL(body.url).searchParams.get("state")! : "", cookie: response.headers.get("Set-Cookie")?.split(";")[0] ?? "" };
}
function callback(state: string, cookie = "", query = "code=fixture-code") {
  return app().request(`${api}/apps/xero/oauth-callback?state=${state}&${query}`, { headers: { Cookie: cookie } });
}
beforeEach(() => {
  process.env.API_URL = api; process.env.DASHBOARD_URL = dashboard;
  process.env.XERO_CLIENT_ID = "fixture-id"; process.env.XERO_CLIENT_SECRET = "fixture-secret";
  process.env.XERO_OAUTH_REDIRECT_URL = `${api}/apps/xero/oauth-callback`;
  authType = "session"; owner = true; verifiedFactor = false; revokeDuringExchange = false;
  records.clear(); for (const fn of [createIntent, consumeIntent, exchange, persist, listFactors]) fn.mockClear();
});
afterAll(() => { for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

describe("native integration OAuth HTTP boundaries", () => {
  test("owner POST sets callback-scoped HttpOnly cookie and one-use opaque state", async () => {
    const result = await start();
    expect(result.response.status).toBe(200);
    expect(result.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(result.response.headers.get("Set-Cookie")).toContain("Path=/apps/xero/oauth-callback");
    expect(result.response.headers.get("Set-Cookie")).toContain("Secure");
    expect(JSON.stringify([...records.values()])).not.toContain(result.state);
    expect((await callback(result.state, result.cookie)).status).toBe(302);
    expect(persist).toHaveBeenCalledTimes(1);
    expect((await callback(result.state, result.cookie)).status).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
  test("API keys and OAuth automation tokens cannot create browser installation intents", async () => {
    for (const type of ["api-key", "oauth"] as const) { authType = type; expect((await start()).response.status).toBe(403); }
    expect(createIntent).not.toHaveBeenCalled();
  });
  test("member start is forbidden, a GET cannot start state", async () => {
    owner = false; expect((await start()).response.status).toBe(403);
    expect((await app().request(`${api}/apps/xero/install-url`)).status).toBe(404);
  });
  test("another browser and legacy encrypted state cannot reach provider HTTP", async () => {
    const result = await start();
    expect((await callback(result.state)).status).toBe(400);
    expect((await callback("legacy-encrypted-state", result.cookie)).status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
    expect((await callback(result.state, result.cookie)).status).toBe(302);
  });
  test("expired state and owner revoked before callback do not exchange", async () => {
    const result = await start(); owner = false;
    expect((await callback(result.state, result.cookie)).status).toBe(400);
    owner = true; for (const value of records.values()) value.expires = Date.now() - 1;
    expect((await callback(result.state, result.cookie)).status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });
  test("late MFA requirement is enforced before consume and provider exchange", async () => {
    const result = await start(); verifiedFactor = true;
    expect((await callback(result.state, result.cookie)).status).toBe(403);
    expect(consumeIntent).not.toHaveBeenCalled(); expect(exchange).not.toHaveBeenCalled();
  });
  test("owner demotion while provider responds prevents integration persistence", async () => {
    const result = await start(); revokeDuringExchange = true;
    const response = await callback(result.state, result.cookie);
    expect(response.headers.get("Location")).toContain("status=error");
    expect(exchange).toHaveBeenCalledTimes(1); expect(persist).not.toHaveBeenCalled();
  });
  test("parallel callbacks and cancellations cannot replay provider exchange", async () => {
    const result = await start();
    await Promise.all([callback(result.state, result.cookie), callback(result.state, result.cookie)]);
    expect(exchange).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
    const canceled = await start();
    expect((await callback(canceled.state, canceled.cookie, "error=access_denied")).headers.get("Location")).toContain("status=error");
    expect((await callback(canceled.state, canceled.cookie)).status).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
  test("upstream callback configuration is rejected without an intent", async () => {
    process.env.XERO_OAUTH_REDIRECT_URL = "https://api.midday.ai/apps/xero/oauth-callback";
    expect((await start()).response.status).toBe(503); expect(createIntent).not.toHaveBeenCalled();
  });
});
