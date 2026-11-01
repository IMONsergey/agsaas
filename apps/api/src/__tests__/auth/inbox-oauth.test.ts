import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context } from "@api/rest/types";
import type { Database } from "@midday/db/client";
import type { CreateInboxOAuthIntentParams } from "@midday/db/queries";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { actorEmail, actorId, signAccessToken } from "./jwt-fixture";

const teamId = "22222222-2222-4222-8222-222222222222";
const apiToken = "mid_" + "a".repeat(64);
const oauthToken = "mid_access_token_inbox-fixture";
const apiUrl = "https://preview.example.test:8544";
const dashboardUrl = "https://preview.example.test:8543";
const db = {} as Database;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
type Provider = "gmail" | "outlook";
type Intent = CreateInboxOAuthIntentParams & {
  id: string;
  expiresAt: number;
  consumed: boolean;
};
const intents = new Map<string, Intent>();
const oldEnv = Object.fromEntries(
  [
    "API_URL",
    "DASHBOARD_URL",
    "ALLOWED_API_ORIGINS",
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REDIRECT_URI",
    "OUTLOOK_CLIENT_ID",
    "OUTLOOK_CLIENT_SECRET",
    "OUTLOOK_REDIRECT_URI",
  ].map((key) => [key, process.env[key]]),
);
let member = true;
let pendingDeletion = false;
let userExists = true;
let factors: Array<{ status: "verified" | "unverified" }> = [];
let factorFailure = false;
const listFactors = mock(async () => {
  if (factorFailure) throw new Error("private-provider-diagnostic");
  return { data: { factors }, error: null };
});
const createIntent = mock(
  async (_db: Database, input: CreateInboxOAuthIntentParams) => {
    if (!member || pendingDeletion || !userExists)
      throw new Error("No current membership");
    const intent = {
      ...input,
      id: randomUUID(),
      expiresAt: Date.now() + 600_000,
      consumed: false,
    };
    intents.set(input.stateHash, intent);
    return { id: intent.id };
  },
);
const consumeIntent = mock(
  async (
    _db: Database,
    input: Pick<
      CreateInboxOAuthIntentParams,
      "stateHash" | "browserNonceHash" | "provider"
    >,
  ) => {
    const intent = intents.get(input.stateHash);
    if (
      !intent ||
      intent.consumed ||
      intent.expiresAt <= Date.now() ||
      intent.browserNonceHash !== input.browserNonceHash ||
      intent.provider !== input.provider ||
      !member ||
      pendingDeletion ||
      !userExists
    )
      return null;
    intent.consumed = true;
    return { ...intent, redirectPath: intent.redirectPath ?? null };
  },
);
const getUserById = mock(async () =>
  userExists
    ? {
        id: actorId,
        email: actorEmail,
        fullName: "Inbox fixture",
        teamId,
        deletionStartedAt: pendingDeletion ? new Date().toISOString() : null,
      }
    : undefined,
);
const exchange = mock(
  async (_params: { code: string; teamId: string; actorUserId: string }) => ({
    id: "account-fixture",
  }),
);
const connect = mock(
  async (provider: Provider, state: string) =>
    `https://provider.example.test/${provider}?state=${state}`,
);
const triggerJob = mock(async () => ({ id: "job-fixture" }));
const logError = mock(() => {});

mock.module("@midday/db/client", () => ({ db }));
mock.module("@midday/db/queries", () => ({
  createInboxOAuthIntent: createIntent,
  consumeInboxOAuthIntent: consumeIntent,
  getUserById,
  hasTeamAccess: async () => member,
  getApiKeyByToken: async () => ({
    id: "key-fixture",
    userId: actorId,
    teamId,
    scopes: ["apis.all"],
  }),
  validateAccessToken: async () => ({
    teamId,
    user: { id: actorId, email: actorEmail },
    scopes: ["apis.all"],
  }),
  updateApiKeyLastUsedAt: async () => {},
}));
mock.module("@api/services/supabase", () => ({
  createAdminClient: async () => ({
    auth: { admin: { mfa: { listFactors } } },
  }),
}));
mock.module("@midday/inbox/connector", () => ({
  InboxConnector: class {
    constructor(private provider: Provider) {}
    connect(state: string) {
      return connect(this.provider, state);
    }
    exchangeCodeForAccount(params: {
      code: string;
      teamId: string;
      actorUserId: string;
    }) {
      return exchange(params);
    }
  },
}));
mock.module("@midday/job-client", () => ({ triggerJob }));
mock.module("@midday/logger", () => ({
  logger: { error: logError, info() {}, warn() {} },
  createLoggerWithContext: () => ({ info() {}, warn() {}, error: logError }),
}));
const { withAuth } = await import("../../rest/middleware/auth");
const attachDb: MiddlewareHandler<Context> = async (c, next) => {
  c.set("db", db);
  await next();
};
// Keep the real REST authentication and handlers; replace only infrastructure.
mock.module("@api/rest/middleware", () => ({
  protectedMiddleware: [attachDb, withAuth],
  publicMiddleware: [attachDb],
}));
const { createInboxInstallUrlRouter, createInboxOAuthCallbackRouter } =
  await import("../../rest/routers/apps/inbox-oauth");
const { inboxOAuthStartCors } = await import(
  "../../rest/middleware/inbox-oauth-cors"
);

function app() {
  const result = new Hono<Context>();
  for (const provider of ["gmail", "outlook"] as const) {
    result.use(`/apps/${provider}/install-url`, inboxOAuthStartCors());
    result.route(
      `/apps/${provider}/install-url`,
      createInboxInstallUrlRouter(provider),
    );
    result.route(
      `/apps/${provider}/oauth-callback`,
      createInboxOAuthCallbackRouter(provider),
    );
  }
  result.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "Request failed" }, 500),
  );
  return result;
}
async function start(
  provider: Provider = "gmail",
  options: {
    bearer?: string;
    source?: "inbox" | "apps";
    redirectPath?: string;
    aal?: "aal1" | "aal2";
  } = {},
) {
  const response = await app().request(
    `${apiUrl}/apps/${provider}/install-url`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.bearer ?? (await signAccessToken({ aal: options.aal ?? "aal1" }))}`,
        "Content-Type": "application/json",
        Origin: dashboardUrl,
      },
      body: JSON.stringify({
        source: options.source ?? "inbox",
        redirectPath: options.redirectPath,
      }),
    },
  );
  const body =
    response.status === 200
      ? ((await response.json()) as { url: string })
      : null;
  return {
    response,
    state: body ? new URL(body.url).searchParams.get("state")! : "",
    cookie: response.headers.get("Set-Cookie")?.split(";")[0] ?? "",
  };
}
function callback(
  provider: Provider,
  state: string,
  cookie?: string,
  query = "code=fixture-code",
) {
  // Provider navigation has no Authorization header. A fresh Hono instance
  // still succeeds because intent state lives behind the database boundary.
  return app().request(
    `${apiUrl}/apps/${provider}/oauth-callback?state=${encodeURIComponent(state)}&${query}`,
    {
      headers: cookie ? { Cookie: cookie } : {},
    },
  );
}

beforeEach(() => {
  process.env.API_URL = apiUrl;
  process.env.DASHBOARD_URL = dashboardUrl;
  process.env.ALLOWED_API_ORIGINS = dashboardUrl;
  for (const provider of ["GMAIL", "OUTLOOK"] as const) {
    process.env[`${provider}_CLIENT_ID`] = "local-fixture-client";
    process.env[`${provider}_CLIENT_SECRET`] = "local-fixture-secret";
    process.env[`${provider}_REDIRECT_URI`] =
      `${apiUrl}/apps/${provider.toLowerCase()}/oauth-callback`;
  }
  member = true;
  pendingDeletion = false;
  userExists = true;
  factors = [];
  factorFailure = false;
  intents.clear();
  for (const fn of [
    listFactors,
    createIntent,
    consumeIntent,
    connect,
    exchange,
    triggerJob,
    logError,
  ])
    fn.mockClear();
});
afterAll(() => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("inbox browser OAuth boundary", () => {
  for (const provider of ["gmail", "outlook"] as const) {
    it(`${provider}: signed-in browser starts and returns without an Authorization callback header`, async () => {
      const flow = await start(provider, { source: "apps" });
      expect(flow.response.status).toBe(200);
      expect(flow.response.headers.get("Access-Control-Allow-Origin")).toBe(
        dashboardUrl,
      );
      expect(
        flow.response.headers.get("Access-Control-Allow-Credentials"),
      ).toBe("true");
      const cookie = flow.response.headers.get("Set-Cookie")!;
      for (const flag of [
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=600",
        `Path=/apps/${provider}/oauth-callback`,
      ])
        expect(cookie).toContain(flag);
      const intent = intents.get(digest(flow.state))!;
      expect(intent).toMatchObject({
        userId: actorId,
        teamId,
        provider,
        source: "apps",
        aal: "aal1",
      });
      expect(intent.stateHash).not.toBe(flow.state);
      expect(intent.browserNonceHash).not.toBe(flow.cookie.split("=")[1]);
      const response = await callback(provider, flow.state, flow.cookie);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        `${dashboardUrl}/oauth-callback?status=success`,
      );
      expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
      expect(exchange).toHaveBeenCalledWith({
        code: "fixture-code",
        teamId,
        actorUserId: actorId,
      });
      expect(triggerJob).toHaveBeenCalledWith(
        "initial-setup",
        { inboxAccountId: "account-fixture", teamId },
        "inbox-provider",
      );
    });
  }

  it("copied state in another browser cannot consume the victim's intent", async () => {
    const flow = await start();
    expect((await callback("gmail", flow.state)).status).toBe(400);
    expect(
      (
        await callback(
          "gmail",
          flow.state,
          `__Secure-agsaas-inbox-oauth-gmail=${secret()}`,
        )
      ).status,
    ).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
    expect((await callback("gmail", flow.state, flow.cookie)).status).toBe(302);
  });

  it("provider substitution, legacy encrypted state and expired state all fail closed", async () => {
    const flow = await start();
    expect(
      (
        await callback(
          "outlook",
          flow.state,
          flow.cookie.replace("gmail=", "outlook="),
        )
      ).status,
    ).toBe(400);
    expect(
      (await callback("gmail", "legacy-encrypted-team-only-state", flow.cookie))
        .status,
    ).toBe(400);
    intents.get(digest(flow.state))!.expiresAt = Date.now() - 1;
    expect((await callback("gmail", flow.state, flow.cookie)).status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("one concurrent callback wins and replay never calls the provider again", async () => {
    const flow = await start();
    const responses = await Promise.all([
      callback("gmail", flow.state, flow.cookie),
      callback("gmail", flow.state, flow.cookie),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      302, 400,
    ]);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect((await callback("gmail", flow.state, flow.cookie)).status).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  for (const revoked of ["membership", "profile", "deletion"] as const) {
    it(`denies ${revoked} changes between start and callback before provider exchange`, async () => {
      const flow = await start();
      if (revoked === "membership") member = false;
      if (revoked === "profile") userExists = false;
      if (revoked === "deletion") pendingDeletion = true;
      expect((await callback("gmail", flow.state, flow.cookie)).status).toBe(
        400,
      );
      expect(exchange).not.toHaveBeenCalled();
    });
  }

  it("rechecks authoritative factors if MFA was enabled while the provider page was open", async () => {
    const flow = await start();
    factors = [{ status: "verified" }];
    expect((await callback("gmail", flow.state, flow.cookie)).status).toBe(403);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("an AAL2 handshake completes for an enrolled user", async () => {
    factors = [{ status: "verified" }];
    const flow = await start("gmail", { aal: "aal2" });
    expect((await callback("gmail", flow.state, flow.cookie)).status).toBe(302);
  });

  it("factor lookup failure denies the callback without provider diagnostics", async () => {
    const flow = await start();
    factorFailure = true;
    const response = await callback("gmail", flow.state, flow.cookie);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-provider-diagnostic");
    expect(exchange).not.toHaveBeenCalled();
  });

  for (const bearer of [apiToken, oauthToken]) {
    it(
      "does not let scoped credentials install an interactive inbox: " +
        bearer.slice(0, 18),
      async () => {
        const flow = await start("gmail", { bearer });
        expect(flow.response.status).toBe(403);
        expect(createIntent).not.toHaveBeenCalled();
        expect(flow.cookie).toBe("");
      },
    );
  }

  it("requires an authenticated POST; an old install GET has no side effect", async () => {
    const result = app();
    expect(
      (await result.request(`${apiUrl}/apps/gmail/install-url`)).status,
    ).not.toBe(200);
    expect(
      (
        await result.request(`${apiUrl}/apps/gmail/install-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(createIntent).not.toHaveBeenCalled();
  });

  it("disabled and foreign callback configurations fail before provider construction", async () => {
    delete process.env.GMAIL_CLIENT_SECRET;
    expect((await start()).response.status).toBe(503);
    process.env.GMAIL_CLIENT_SECRET = "fixture";
    process.env.GMAIL_REDIRECT_URI =
      "https://api.midday.ai/apps/gmail/oauth-callback";
    expect((await start()).response.status).toBe(503);
    expect(connect).not.toHaveBeenCalled();
    expect(createIntent).not.toHaveBeenCalled();
  });

  it("valid cancellation consumes the intent and uses a sanitized own-dashboard return path", async () => {
    const flow = await start("gmail", {
      redirectPath: "//outside.example.test",
    });
    const response = await callback(
      "gmail",
      flow.state,
      flow.cookie,
      "error=access_denied",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `${dashboardUrl}/inbox?connected=false&error=access_denied&provider=gmail`,
    );
    expect(exchange).not.toHaveBeenCalled();
    expect((await callback("gmail", flow.state, flow.cookie)).status).toBe(400);
  });

  it("provider exceptions do not expose codes, tokens or diagnostics in logs or redirects", async () => {
    const flow = await start();
    exchange.mockImplementationOnce(async () => {
      throw new Error(
        "private-provider-diagnostic authorization-code-and-token",
      );
    });
    const response = await callback("gmail", flow.state, flow.cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain(
      "error=token_exchange_failed",
    );
    expect(logError).toHaveBeenCalledWith("Inbox OAuth connection failed", {
      provider: "gmail",
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain(
      "private-provider-diagnostic",
    );
  });
});

describe("inbox start credentialed CORS", () => {
  it("allows the exact configured origin on preflight", async () => {
    const response = await app().request(`${apiUrl}/apps/gmail/install-url`, {
      method: "OPTIONS",
      headers: {
        Origin: dashboardUrl,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      dashboardUrl,
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
  });
  it("never reflects unconfigured origins or expands a wildcard configuration", async () => {
    process.env.ALLOWED_API_ORIGINS = `${dashboardUrl},*,https://preview.example.test.evil.test/path`;
    for (const origin of [
      "https://evil.example.test",
      "https://preview.example.test:9999",
    ]) {
      const response = await app().request(`${apiUrl}/apps/gmail/install-url`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });
});
