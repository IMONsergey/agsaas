import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountSmokeFailureOutput,
  parseAccountSmokeArguments,
  readAccountSmokeConfig,
  runSelfHostedAccountSmoke,
} from "./self-hosted-account-smoke.mts";

// OFFLINE protocol/runner contracts, not real Supabase, Auth or RLS evidence.
// Only the separately authorized matched-stack run proves those integrations.
const privateMarker = "private-account-smoke-data-must-not-be-printed";
const publishable = "sb_publishable_offline_account_fixture";
const otp = "123456";
const env = {
  SUPABASE_PUBLIC_URL: "http://127.0.0.1:3800",
  AGSAAS_API_URL: "http://127.0.0.1:3303",
  SELF_HOSTED_SMOKE_MAILPIT_URL: "http://127.0.0.1:3825",
  SUPABASE_PUBLISHABLE_KEY: publishable,
  SMTP_HOST: "mailpit",
  SMTP_PORT: "1025",
  ENABLE_EMAIL_AUTOCONFIRM: "false",
  SUPABASE_SECRET_KEY: privateMarker,
  SERVICE_ROLE_KEY: privateMarker,
  INTERNAL_API_KEY: privateMarker,
};
const config = readAccountSmokeConfig(env);
const json = (body: unknown, status = 200) => Response.json(body, { status });
const trpc = (value: unknown) => json({ result: { data: { json: value } } });
const denied = (code = "NOT_FOUND", status = 404) =>
  json(
    {
      error: {
        json: { message: privateMarker, data: { code }, stack: privateMarker },
      },
    },
    status,
  );

type FixtureState = {
  userId: string;
  teamId: string | null;
  email: string;
  name: string;
  token: string;
  deleted: boolean;
};

function httpFixture(
  options: {
    claims?: Record<string, unknown>;
    override?: (
      request: Request,
      state: FixtureState,
    ) => Response | undefined | Promise<Response | undefined>;
  } = {},
) {
  const state: FixtureState = {
    userId: randomUUID(),
    teamId: null,
    email: "",
    name: "",
    token: "",
    deleted: false,
  };
  const calls: Request[] = [];
  const profile = () => ({
    id: state.userId,
    email: state.email,
    full_name: state.name,
    team_id: state.teamId,
  });
  const fetchFixture = async (url: string | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const request = new Request(url, init);
    calls.push(request.clone());
    const override = await options.override?.(request.clone(), state);
    if (override) return override;
    const parsed = new URL(request.url);
    const path = parsed.pathname;
    const payload =
      request.method === "POST" ? await request.json() : undefined;
    if (path.startsWith("/auth/") || path.startsWith("/rest/")) {
      expect(request.headers.get("apikey")).toBe(publishable);
      expect(request.headers.get("x-supabase-api-version")).toBe("2024-01-01");
    }
    if (path === "/api/v1/webui")
      return json({
        Label: "AGSaaS private stage - captured test mail only",
        MessageRelay: { Enabled: false, SMTPServer: "" },
      });
    if (path === "/health/ready") return json({ status: "ok" });
    if (path === "/auth/v1/otp") {
      expect(request.method).toBe("POST");
      expect(payload.create_user).toBe(true);
      expect(payload.email).toMatch(/^smoke-[0-9a-f-]{36}@example\.test$/);
      expect(request.headers.has("authorization")).toBe(false);
      expect(state.email).toBe("");
      state.email = payload.email;
      state.name = payload.data.full_name;
      return json({});
    }
    if (path === "/api/v1/search") {
      expect(parsed.searchParams.get("query")).toBe(`to:"${state.email}"`);
      expect(parsed.searchParams.get("limit")).toBe("5");
      expect(request.headers.has("authorization")).toBe(false);
      return json({
        messages: [
          {
            ID: "account-fixture-message",
            To: [{ Address: state.email }],
            Cc: [],
            Bcc: null,
          },
        ],
      });
    }
    if (path === "/api/v1/message/account-fixture-message")
      return json({
        ID: "account-fixture-message",
        To: [{ Address: state.email }],
        Cc: [],
        Bcc: null,
        Text: `Your code is ${otp}`,
        HTML: `<b>${otp}</b>`,
      });
    if (path === "/auth/v1/verify") {
      expect(payload).toEqual({
        email: state.email,
        token: otp,
        type: "email",
      });
      const claims = {
        sub: state.userId,
        email: state.email,
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...options.claims,
      };
      state.token = `${Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature`;
      return json({
        access_token: state.token,
        token_type: "bearer",
        refresh_token: privateMarker,
        user: {
          id: state.userId,
          email: state.email,
          email_confirmed_at: new Date().toISOString(),
        },
      });
    }
    expect(request.headers.get("authorization")).toBe(`Bearer ${state.token}`);
    if (path === "/auth/v1/user")
      return state.deleted
        ? json({ code: "user_not_found", message: privateMarker }, 403)
        : json({ id: state.userId, email: state.email });
    if (path === "/rest/v1/users") {
      expect(parsed.searchParams.get("id")).toBe(`eq.${state.userId}`);
      expect(parsed.searchParams.get("select")).toBe(
        "id,email,full_name,team_id",
      );
      expect(parsed.searchParams.get("limit")).toBe("2");
      expect(request.method).toBe("GET");
      return json(state.deleted ? [] : [profile()]);
    }
    expect(path.startsWith("/trpc/")).toBe(true);
    expect(request.headers.get("x-force-primary")).toBe("true");
    expect(request.headers.has("apikey")).toBe(false);
    switch (path.slice("/trpc/".length)) {
      case "user.me":
        return state.deleted
          ? denied()
          : trpc({
              id: state.userId,
              email: state.email,
              teamId: state.teamId,
            });
      case "team.list":
        return trpc(
          state.teamId
            ? [{ id: state.teamId, name: state.name, role: "owner" }]
            : [],
        );
      case "team.create":
        expect(state.teamId).toBeNull();
        expect(payload.json).toEqual({
          name: state.name,
          baseCurrency: "USD",
          countryCode: "US",
          companyType: "solo_founder",
          heardAbout: "other",
          switchTeam: true,
        });
        state.teamId = randomUUID();
        return trpc(state.teamId);
      case "team.current":
        return trpc({ id: state.teamId, name: state.name });
      case "team.members":
        return trpc([
          {
            teamId: state.teamId,
            role: "owner",
            user: { id: state.userId, email: state.email },
          },
        ]);
      case "user.delete":
        expect(request.method).toBe("POST");
        expect(payload).toEqual({ json: null });
        expect(state.deleted).toBe(false);
        expect(state.teamId).not.toBeNull();
        state.deleted = true;
        return trpc({ id: state.userId });
      default:
        throw new Error(`Unexpected fixture route ${privateMarker}`);
    }
  };
  return { fetch: fetchFixture, state, calls };
}

function countCalls(fixture: ReturnType<typeof httpFixture>, path: string) {
  return fixture.calls.filter(
    (request) => new URL(request.url).pathname === path,
  ).length;
}

async function runFailure(
  fixture: ReturnType<typeof httpFixture>,
  timeouts?: { otpMs?: number; pollMs?: number; requestMs?: number },
) {
  try {
    await runSelfHostedAccountSmoke(config, {
      allowTestWrites: true,
      fetch: fixture.fetch,
      timeouts,
    });
    throw new Error("Expected account smoke to fail");
  } catch (error) {
    const output = JSON.stringify(accountSmokeFailureOutput(error));
    for (const secret of [
      publishable,
      privateMarker,
      otp,
      fixture.state.email,
      fixture.state.token,
    ].filter(Boolean))
      expect(output).not.toContain(secret);
    expect(output).toContain('"status":"failed"');
    return JSON.parse(output);
  }
}

describe("account smoke configuration", () => {
  test("requires explicit CLI and programmatic write permission before any request", async () => {
    expect(parseAccountSmokeArguments(["--help"])).toBe("help");
    expect(parseAccountSmokeArguments(["--allow-test-writes"])).toBe("run");
    for (const args of [
      [],
      [privateMarker],
      ["--allow-test-writes", "--force"],
    ])
      expect(() => parseAccountSmokeArguments(args)).toThrow(
        "explicit --allow-test-writes",
      );
    const fixture = httpFixture();
    await expect(
      runSelfHostedAccountSmoke(config, { fetch: fixture.fetch }),
    ).rejects.toThrow("explicit test writes permission");
    expect(fixture.calls).toHaveLength(0);
  });

  test.each([
    { RESEND_API_KEY: privateMarker },
    { RESEND_AUDIENCE_ID: privateMarker },
    { SMTP_HOST: "smtp.external.invalid" },
    { ENABLE_EMAIL_AUTOCONFIRM: "true" },
    { SUPABASE_PUBLISHABLE_KEY: "sb_secret_private" },
    { SUPABASE_PUBLIC_URL: "http://10.0.0.1" },
    { AGSAAS_API_URL: "https://api.external.invalid" },
    { SELF_HOSTED_SMOKE_MAILPIT_URL: "http://localhost@external.invalid" },
  ])("rejects unsafe deployment settings without retaining secrets %j", (override) => {
    try {
      readAccountSmokeConfig({ ...env, ...override });
      throw new Error("Expected invalid configuration");
    } catch (error) {
      expect(JSON.stringify(accountSmokeFailureOutput(error))).not.toContain(
        privateMarker,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("configuration:");
    }
  });

  test("revalidates direct callers' origins and provider guard", async () => {
    const fixture = httpFixture();
    await expect(
      runSelfHostedAccountSmoke(
        { ...config, apiUrl: "http://127.1" },
        { allowTestWrites: true, fetch: fixture.fetch },
      ),
    ).rejects.toThrow("loopback");
    await expect(
      runSelfHostedAccountSmoke(
        { ...config, marketingCleanupDisabled: false as never },
        { allowTestWrites: true, fetch: fixture.fetch },
      ),
    ).rejects.toThrow("disabled provider cleanup");
    expect(fixture.calls).toHaveLength(0);
    expect(JSON.stringify(config)).not.toContain(privateMarker);
  });

  test("unknown error messages and stacks are always suppressed", () => {
    expect(
      JSON.stringify(accountSmokeFailureOutput(new Error(privateMarker))),
    ).not.toContain(privateMarker);
  });
});

describe("sole-owner account lifecycle HTTP contracts", () => {
  test("uses only Auth-issued session, scoped profile reads and one own user.delete", async () => {
    const fixture = httpFixture();
    const report = await runSelfHostedAccountSmoke(config, {
      allowTestWrites: true,
      fetch: fixture.fetch,
    });
    expect(report.status).toBe("passed");
    expect(report.fixture).toMatchObject({
      userId: fixture.state.userId,
      teamId: fixture.state.teamId,
      deletionState: "verified",
    });
    expect(report.checks).toHaveLength(6);
    expect(report.sharedLastOwner).toBe(
      "not-exercised-trigger-provider-required",
    );
    expect(
      fixture.calls
        .filter((request) => request.method !== "GET")
        .map((request) => new URL(request.url).pathname),
    ).toEqual([
      "/auth/v1/otp",
      "/auth/v1/verify",
      "/trpc/team.create",
      "/trpc/user.delete",
    ]);
    expect(
      fixture.calls.some((request) =>
        /admin|invite|payment|invoice|storage|logout|generate_link/.test(
          new URL(request.url).pathname,
        ),
      ),
    ).toBe(false);
    for (const secret of [
      publishable,
      privateMarker,
      otp,
      fixture.state.email,
      fixture.state.token,
    ])
      expect(JSON.stringify(report)).not.toContain(secret);
  });

  test("separate runs never reuse identities or target previous fixtures", async () => {
    const first = httpFixture();
    const second = httpFixture();
    const a = await runSelfHostedAccountSmoke(config, {
      allowTestWrites: true,
      fetch: first.fetch,
    });
    const b = await runSelfHostedAccountSmoke(config, {
      allowTestWrites: true,
      fetch: second.fetch,
    });
    expect(a.runId).not.toBe(b.runId);
    expect(a.fixture.identityId).not.toBe(b.fixture.identityId);
    expect(first.state.email).not.toBe(second.state.email);
  });

  test("cannot request OTP before capture-only relay/readiness checks", async () => {
    const fixture = httpFixture({
      override: (request) =>
        new URL(request.url).pathname === "/api/v1/webui"
          ? json({
              Label: privateMarker,
              MessageRelay: { Enabled: true, SMTPServer: privateMarker },
            })
          : undefined,
    });
    const output = await runFailure(fixture);
    expect(output.error).toContain("mailpit guard");
    expect(countCalls(fixture, "/auth/v1/otp")).toBe(0);
  });

  test("does not read another recipient's message or resend OTP on delivery timeout", async () => {
    const fixture = httpFixture({
      override: (request) =>
        new URL(request.url).pathname === "/api/v1/search"
          ? json({
              messages: [
                { ID: "not-owned", To: [{ Address: "someone@example.test" }] },
              ],
            })
          : undefined,
    });
    const output = await runFailure(fixture, { otpMs: 25, pollMs: 2 });
    expect(output.error).toContain("OTP delivery deadline");
    expect(countCalls(fixture, "/auth/v1/otp")).toBe(1);
    expect(countCalls(fixture, "/auth/v1/verify")).toBe(0);
    expect(
      fixture.calls.some((request) =>
        new URL(request.url).pathname.startsWith("/api/v1/message/"),
      ),
    ).toBe(false);
  });

  test.each([
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { exp: Math.floor(Date.now() / 1000) + 120 },
    { role: "service_role" },
    { sub: randomUUID() },
    { email: "not-owned@example.test" },
  ])("refuses wrong or expiring JWT claims before team creation %j", async (claims) => {
    const fixture = httpFixture({ claims });
    const output = await runFailure(fixture);
    expect(output.error).toContain("fresh unexpired user JWT");
    expect(countCalls(fixture, "/trpc/team.create")).toBe(0);
    expect(countCalls(fixture, "/trpc/user.delete")).toBe(0);
  });

  test("stops before creating or deleting a team if the fresh account has an existing team", async () => {
    const fixture = httpFixture({
      override: (request) =>
        new URL(request.url).pathname === "/trpc/team.list"
          ? trpc([{ id: randomUUID(), role: "owner" }])
          : undefined,
    });
    const output = await runFailure(fixture);
    expect(output.error).toContain("no existing teams");
    expect(countCalls(fixture, "/trpc/team.create")).toBe(0);
    expect(countCalls(fixture, "/trpc/user.delete")).toBe(0);
  });

  test.each([
    "extra-member",
    "not-owner",
    "wrong-team",
    "wrong-user",
  ])("never deletes when sole-owner precondition fails: %s", async (mode) => {
    const fixture = httpFixture({
      override: (request, state) => {
        if (new URL(request.url).pathname !== "/trpc/team.members") return;
        const member = {
          teamId: mode === "wrong-team" ? randomUUID() : state.teamId,
          role: mode === "not-owner" ? "member" : "owner",
          user: {
            id: mode === "wrong-user" ? randomUUID() : state.userId,
            email: state.email,
          },
        };
        return trpc(mode === "extra-member" ? [member, member] : [member]);
      },
    });
    expect((await runFailure(fixture)).report.fixture.deletionState).toBe(
      "not-started",
    );
    expect(countCalls(fixture, "/trpc/user.delete")).toBe(0);
  });

  test("an ambiguous delete timeout is redacted, reported and never retried or cleaned up", async () => {
    const fixture = httpFixture({
      override: (request, state) => {
        if (new URL(request.url).pathname !== "/trpc/user.delete") return;
        state.deleted = true; // The server committed, but the response was lost.
        throw new Error(
          `${privateMarker} ${state.token} ${state.email} ${otp}`,
        );
      },
    });
    const output = await runFailure(fixture);
    expect(output.error).toContain("network, timeout or redirect failure");
    expect(output.report.fixture.deletionState).toBe("requested");
    expect(countCalls(fixture, "/trpc/user.delete")).toBe(1);
    expect(new URL(fixture.calls.at(-1)!.url).pathname).toBe(
      "/trpc/user.delete",
    );
  });

  test.each([
    "bad_jwt",
    "session_not_found",
    "user_banned",
    "unexpected_failure",
  ])("generic Auth rejection does not prove user deletion: %s", async (code) => {
    const fixture = httpFixture({
      override: (request, state) =>
        new URL(request.url).pathname === "/auth/v1/user" && state.deleted
          ? json({ code, message: privateMarker }, 403)
          : undefined,
    });
    const output = await runFailure(fixture);
    expect(output.error).toContain("Auth confirms user no longer exists");
    expect(output.report.fixture.deletionState).toBe("api-confirmed");
  });

  test.each([
    "remaining-profile",
    "unauthorized-profile",
    "api-still-allowed",
    "wrong-api-denial",
  ])("does not call missing account checks successful on %s", async (mode) => {
    const fixture = httpFixture({
      override: (request, state) => {
        if (!state.deleted) return;
        const path = new URL(request.url).pathname;
        if (path === "/rest/v1/users" && mode === "remaining-profile")
          return json([
            { id: state.userId, deletion_started_at: new Date().toISOString() },
          ]);
        if (path === "/rest/v1/users" && mode === "unauthorized-profile")
          return json({ message: privateMarker }, 401);
        if (path === "/trpc/user.me" && mode === "api-still-allowed")
          return trpc({ id: state.userId });
        if (path === "/trpc/user.me" && mode === "wrong-api-denial")
          return denied("UNAUTHORIZED", 401);
      },
    });
    const output = await runFailure(fixture);
    expect(output.report.fixture.deletionState).toBe("api-confirmed");
    expect(countCalls(fixture, "/trpc/user.delete")).toBe(1);
  });

  test("limits response bytes without printing the body", async () => {
    const fixture = httpFixture({
      override: () => new Response(privateMarker.repeat(30_000)),
    });
    expect((await runFailure(fixture)).error).toContain("size limit");
    expect(countCalls(fixture, "/auth/v1/otp")).toBe(0);
  });

  test("pre-cancelled runs do not call even the supplied HTTP transport", async () => {
    const fixture = httpFixture();
    await expect(
      runSelfHostedAccountSmoke(config, {
        allowTestWrites: true,
        fetch: fixture.fetch,
        signal: AbortSignal.abort(privateMarker),
      }),
    ).rejects.toThrow("total deadline or cancellation");
    expect(fixture.calls).toHaveLength(0);
  });

  test("request deadlines interrupt transport and never continue to OTP", async () => {
    const fixture = httpFixture({
      override: (request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(new Error(privateMarker)),
            { once: true },
          ),
        ),
    });
    expect((await runFailure(fixture, { requestMs: 15 })).error).toContain(
      "timeout",
    );
    expect(countCalls(fixture, "/auth/v1/otp")).toBe(0);
  });
});

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function runNode(args: string[], environment: Record<string, string>) {
  const script = fileURLToPath(
    new URL("./self-hosted-account-smoke.mts", import.meta.url),
  );
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        "node",
        [...args, script, "--allow-test-writes"],
        {
          env: { PATH: process.env.PATH ?? "", ...environment },
          timeout: 8000,
          maxBuffer: 128 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? 1 : 0, stdout, stderr }),
      );
    },
  );
}

describe("Node CLI with native fetch on disposable loopback fixtures", () => {
  test("loads --env-file, performs the deletion contract and redacts secrets from both streams", async () => {
    const fixture = httpFixture();
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(",") : value);
        const result = await fixture.fetch(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers,
          redirect: "error",
          signal: new AbortController().signal,
          ...(request.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
        });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: privateMarker }));
      }
    });
    const temporary = mkdtempSync(join(tmpdir(), "agsaas-account-smoke-cli-"));
    try {
      const origin = await listen(server);
      const file = join(temporary, "fixture.env");
      writeFileSync(
        file,
        Object.entries({
          ...env,
          SUPABASE_PUBLIC_URL: origin,
          AGSAAS_API_URL: origin,
          SELF_HOSTED_SMOKE_MAILPIT_URL: origin,
        })
          .map(([name, value]) => `${name}=${value}`)
          .join("\n"),
        { mode: 0o600 },
      );
      const result = await runNode([`--env-file=${file}`], {});
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).fixture.deletionState).toBe("verified");
      for (const secret of [
        privateMarker,
        publishable,
        otp,
        fixture.state.token,
        fixture.state.email,
      ])
        expect(result.stdout + result.stderr).not.toContain(secret);
    } finally {
      await close(server);
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 10_000);

  test("a redirect never sends keys or user tokens to the redirect target", async () => {
    let targetCalls = 0;
    const target = createServer((_request, response) => {
      targetCalls++;
      response.end("unexpected");
    });
    let targetOrigin = "";
    const redirect = createServer((_request, response) => {
      response.writeHead(302, { location: `${targetOrigin}/${privateMarker}` });
      response.end();
    });
    try {
      targetOrigin = await listen(target);
      const origin = await listen(redirect);
      const result = await runNode([], {
        ...env,
        SELF_HOSTED_SMOKE_MAILPIT_URL: origin,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toContain("redirect failure");
      expect(result.stderr).not.toContain(privateMarker);
      expect(result.stderr).not.toContain(publishable);
      expect(targetCalls).toBe(0);
    } finally {
      await close(redirect);
      await close(target);
    }
  }, 10_000);
});
