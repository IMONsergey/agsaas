import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCaptureOnlyMailpit,
  extractMailpitOtp,
  loopbackBaseUrl,
  parseSmokeArguments,
  readSmokeConfig,
  runSelfHostedSmoke,
  smokeFailureOutput,
} from "./self-hosted-smoke.mts";

// Offline runner contract tests. These fixtures are NOT Supabase/Auth/RLS
// integration evidence. Only root's explicit stage execution exercises those.
const privateMarker = "private-response-marker-must-not-be-printed";
const publishable = "sb_publishable_offline_fixture_only";
const captureConfig = {
  Label: "AGSaaS private stage - captured test mail only",
  MessageRelay: { Enabled: false, SMTPServer: "" },
};
const fixtureEnv = {
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
const exampleEmail = `smoke-${randomUUID()}@example.test`;
const message = {
  ID: "fixture-message",
  To: [{ Name: "", Address: exampleEmail }],
  Cc: null,
  Bcc: [],
  Text: "Your sign-in code is 123456.",
  HTML: '<p><strong>123456</strong></p><a href="http://unused.invalid/987654">Do not follow links</a>',
};

describe("self-hosted smoke configuration", () => {
  test("requires explicit writes and accepts only the documented CLI", () => {
    expect(parseSmokeArguments(["--help"])).toBe("help");
    expect(parseSmokeArguments(["--allow-test-writes"])).toBe("run");
    for (const args of [
      [],
      ["--allow-test-writes", "--force"],
      ["--env-file=private"],
      [privateMarker],
    ]) {
      expect(() => parseSmokeArguments(args)).toThrow(
        "explicit --allow-test-writes",
      );
    }
  });

  test.each([
    "http://localhost:3800",
    "http://127.0.0.1:3800/",
    "https://[::1]:3800",
  ])("permits explicit loopback origin %s", (url) => {
    expect(loopbackBaseUrl(url, "setting")).toBe(new URL(url).origin);
  });

  test.each([
    undefined,
    "",
    "not a URL",
    "https://project.supabase.co",
    "http://192.168.1.10:3800",
    "http://api-gw:8000",
    "http://localhost.evil.invalid",
    "http://127.0.0.1.evil.invalid",
    "http://localhost@evil.invalid",
    "http://secret:password@localhost",
    "http://@localhost",
    "http://localhost/rest/v1",
    "http://localhost/?key=private",
    "http://localhost/#private",
    "http://localhost/?",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://%6cocalhost",
    "ftp://localhost",
    " http://localhost",
    "http://localhost\n",
  ])("rejects a nonliteral or unsafe base URL %s", (url) => {
    expect(() => loopbackBaseUrl(url, "setting")).toThrow("setting:");
  });

  test("uses only a publishable key and does not retain server secrets", () => {
    const config = readSmokeConfig(fixtureEnv);
    expect(config.publishableKey).toBe(publishable);
    expect(JSON.stringify(config)).not.toContain(privateMarker);
    expect(
      readSmokeConfig({
        ...fixtureEnv,
        SELF_HOSTED_SMOKE_MAILPIT_URL: undefined,
      }).mailpitUrl,
    ).toBe("http://127.0.0.1:3825");
  });

  test.each([
    { SMTP_HOST: "smtp.external.invalid" },
    { SMTP_PORT: "587" },
    { ENABLE_EMAIL_AUTOCONFIRM: "true" },
    { ENABLE_EMAIL_AUTOCONFIRM: undefined },
    { SUPABASE_PUBLISHABLE_KEY: undefined },
    { SUPABASE_PUBLISHABLE_KEY: "sb_secret_private" },
    { SUPABASE_PUBLISHABLE_KEY: "header.payload.signature" },
  ])("fails closed for unsafe mail/key configuration %j", (override) => {
    expect(() => readSmokeConfig({ ...fixtureEnv, ...override })).toThrow(
      "configuration:",
    );
  });

  test("Mailpit must identify the exact capture-only deployment and disable relay", () => {
    expect(() => assertCaptureOnlyMailpit(captureConfig)).not.toThrow();
    for (const value of [
      null,
      {},
      { ...captureConfig, Label: "production" },
      { ...captureConfig, MessageRelay: { Enabled: true } },
      {
        ...captureConfig,
        MessageRelay: { Enabled: false, SMTPServer: "relay.invalid" },
      },
    ]) {
      expect(() => assertCaptureOnlyMailpit(value)).toThrow("mailpit guard");
    }
  });
});

describe("Mailpit OTP extraction", () => {
  test("deduplicates text/HTML OTP and never follows HTML attributes", () => {
    expect(extractMailpitOtp(message, exampleEmail)).toBe("123456");
    expect(
      extractMailpitOtp(
        {
          ...message,
          Text: "",
          HTML: "<style>987654</style><script>987654</script><b>123456</b>",
        },
        exampleEmail,
      ),
    ).toBe("123456");
  });

  test.each([
    { To: [{ Address: "someone@example.test" }] },
    { To: [...message.To, { Address: "another@example.test" }] },
    { Cc: [{ Address: "another@example.test" }] },
    { Bcc: [{ Address: "another@example.test" }] },
    { Text: "No code", HTML: "<b>No code</b>" },
    { Text: "123456 or 654321" },
  ])("rejects a wrong recipient or ambiguous code without echoing it %j", (override) => {
    expect(() =>
      extractMailpitOtp({ ...message, ...override }, exampleEmail),
    ).toThrow("mailpit OTP");
  });

  test("does not accept an operator-supplied real or plus-addressed email", () => {
    for (const email of [
      "real@example.com",
      "smoke+test@example.test",
      `smoke-${"a".repeat(36)}@example.test`,
    ]) {
      expect(() =>
        extractMailpitOtp({ ...message, To: [{ Address: email }] }, email),
      ).toThrow("mailpit OTP identity");
    }
  });
});

type FixtureUser = {
  id: string;
  email: string;
  fullName: string;
  messageId: string;
  token: string;
  teamId: string | null;
  name?: string;
  project?: Record<string, unknown>;
  entry?: Record<string, unknown>;
};

function httpFixture(
  options: {
    profileLeak?: boolean;
    projectLeak?: boolean;
    switchStatus?: number;
    override?: (request: Request) => Response | undefined;
  } = {},
) {
  const users: FixtureUser[] = [];
  const calls: Request[] = [];
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const trpc = (value: unknown) => json({ result: { data: { json: value } } });

  async function fetchFixture(
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const request = new Request(url, init);
    calls.push(request.clone());
    const override = options.override?.(request);
    if (override) return override;
    const parsed = new URL(request.url);
    const path = parsed.pathname;
    const payload =
      request.method === "POST" ? await request.json() : undefined;
    const user = users.find(
      (candidate) =>
        request.headers.get("authorization") === `Bearer ${candidate.token}`,
    );

    if (path.startsWith("/api/v1/")) {
      expect(request.method).toBe("GET");
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("apikey")).toBe(false);
    }
    if (path.startsWith("/auth/v1/") || path.startsWith("/rest/v1/")) {
      expect(request.headers.get("apikey")).toBe(publishable);
    }
    if (path === "/api/v1/webui") return json(captureConfig);
    if (path === "/health/ready") return json({ status: "ok" });
    if (path === "/auth/v1/otp") {
      expect(request.method).toBe("POST");
      expect(payload.email).toMatch(/^smoke-[0-9a-f-]{36}@example\.test$/);
      expect(payload.create_user).toBe(true);
      expect(users.some((existing) => existing.email === payload.email)).toBe(
        false,
      );
      const id = randomUUID();
      users.push({
        id,
        email: payload.email,
        fullName: payload.data.full_name,
        messageId: randomUUID(),
        // Only this offline HTTP fixture accepts this token. Never signed or
        // presented to Supabase; the real runner obtains tokens from Auth.
        token: `offline_fixture.${id.replaceAll("-", "")}.not_a_real_signature`,
        teamId: null,
      });
      return json({});
    }
    if (path === "/api/v1/search") {
      const email = /^to:"([^"]+)"$/.exec(
        parsed.searchParams.get("query") ?? "",
      )?.[1];
      const target = users.find((value) => value.email === email);
      return json({
        messages: target
          ? [
              {
                ID: target.messageId,
                To: [{ Address: target.email }],
                Cc: null,
                Bcc: [],
              },
            ]
          : [],
      });
    }
    if (path.startsWith("/api/v1/message/")) {
      const target = users.find(
        (value) => value.messageId === path.split("/").at(-1),
      );
      expect(target).toBeDefined();
      return json({
        ...message,
        ID: target!.messageId,
        To: [{ Address: target!.email }],
      });
    }
    if (path === "/auth/v1/verify") {
      expect(payload.type).toBe("email");
      expect(payload.token).toBe("123456");
      const target = users.find((value) => value.email === payload.email)!;
      return json({
        access_token: target.token,
        refresh_token: privateMarker,
        token_type: "bearer",
        user: {
          id: target.id,
          email: target.email,
          email_confirmed_at: new Date().toISOString(),
        },
      });
    }
    expect(user).toBeDefined();
    if (!user) return json({ error: privateMarker }, 401);
    if (path === "/rest/v1/users") {
      const id = parsed.searchParams.get("id")?.slice(3);
      const target = options.profileLeak
        ? users.find((value) => value.id === id)
        : user.id === id
          ? user
          : undefined;
      return json(
        target
          ? [
              {
                id: target.id,
                email: target.email,
                full_name: target.fullName,
                team_id: target.teamId,
              },
            ]
          : [],
      );
    }
    if (path === "/rest/v1/teams") {
      return json(
        parsed.searchParams.get("id") === `eq.${user.teamId}`
          ? [{ id: user.teamId, name: user.name }]
          : [],
      );
    }
    expect(path.startsWith("/trpc/")).toBe(true);
    expect(request.headers.has("apikey")).toBe(false);
    expect(request.headers.has("x-internal-key")).toBe(false);
    const input =
      payload?.json ??
      JSON.parse(parsed.searchParams.get("input") ?? "{}").json;
    switch (path.slice("/trpc/".length)) {
      case "user.me":
        return trpc({
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          teamId: user.teamId,
          fileKey: privateMarker,
        });
      case "team.create":
        expect(input.switchTeam).toBe(true);
        expect(input.companyType).toBe("solo_founder");
        expect(input.heardAbout).toBe("other");
        user.teamId = randomUUID();
        user.name = input.name;
        return trpc(user.teamId);
      case "team.current":
        return trpc({ id: user.teamId, name: user.name });
      case "customers.get":
        return trpc({ data: [], meta: {} });
      case "trackerProjects.upsert":
        user.project = { ...input, id: randomUUID(), teamId: user.teamId };
        return trpc(user.project);
      case "trackerEntries.upsert":
        expect(input.projectId).toBe(user.project!.id);
        expect(input.assignedId).toBe(user.id);
        user.entry = { ...input, id: randomUUID(), teamId: user.teamId };
        return trpc([user.entry]);
      case "trackerProjects.getById": {
        const target = options.projectLeak
          ? users.find((value) => value.project?.id === input.id)
          : user.project?.id === input.id
            ? user
            : undefined;
        return trpc(
          target
            ? { ...target.project, totalDuration: "60", totalAmount: 2 }
            : null,
        );
      }
      case "trackerEntries.byDate":
        return trpc({
          data: [
            {
              ...user.entry,
              trackerProject: user.project,
              user: { id: user.id },
            },
          ],
          meta: { totalDuration: 60 },
        });
      case "user.switchTeam":
        expect(input.teamId).not.toBe(user.teamId);
        return json(
          {
            error: {
              json: {
                message: privateMarker,
                data: {
                  code:
                    options.switchStatus === 500
                      ? "INTERNAL_SERVER_ERROR"
                      : "FORBIDDEN",
                },
              },
            },
          },
          options.switchStatus ?? 403,
        );
      default:
        throw new Error("Offline fixture received an unexpected route");
    }
  }
  return { fetch: fetchFixture, users, calls };
}

describe("bounded smoke orchestration (offline HTTP responses)", () => {
  test.each([
    "sb_secret_private",
    "legacy.service.token",
  ])("programmatic runner rejects a server key before any fetch %s", async (key) => {
    const fixture = httpFixture();
    await expect(
      runSelfHostedSmoke(
        { ...readSmokeConfig(fixtureEnv), publishableKey: key },
        { fetch: fixture.fetch },
      ),
    ).rejects.toThrow("publishable key");
    expect(fixture.calls).toHaveLength(0);
  });

  test("covers real wire contracts while forwarding no server key and retaining only IDs", async () => {
    const fixture = httpFixture();
    const report = await runSelfHostedSmoke(readSmokeConfig(fixtureEnv), {
      fetch: fixture.fetch,
    });
    expect(report.status).toBe("passed");
    expect(report.checks).toHaveLength(13);
    expect(report.fixtures).toHaveLength(2);
    expect(report.fixturesRetained).toBe(true);
    expect(report.customerMode).toBe("read-only");
    expect(report.externalEmailDelivery).toBe(false);
    expect(new Set(fixture.users.map((user) => user.email)).size).toBe(2);
    for (const secret of [
      publishable,
      privateMarker,
      "123456",
      ...fixture.users.flatMap((user) => [user.email, user.token]),
    ]) {
      expect(JSON.stringify(report)).not.toContain(secret);
    }
    expect(
      fixture.calls.filter(
        (request) => new URL(request.url).pathname === "/auth/v1/otp",
      ),
    ).toHaveLength(2);
    expect(
      fixture.calls.some((request) =>
        /enrich|storage|admin|delete|release|send|customers\.upsert/.test(
          new URL(request.url).pathname,
        ),
      ),
    ).toBe(false);
    for (const request of fixture.calls) {
      expect(JSON.stringify([...request.headers])).not.toContain(privateMarker);
      expect(request.method).not.toBe("DELETE");
    }
  });

  test("never sends OTP before the capture-only relay guard succeeds", async () => {
    const fixture = httpFixture({
      override: () =>
        Response.json({
          ...captureConfig,
          MessageRelay: { Enabled: true, SMTPServer: "relay.invalid" },
        }),
    });
    await expect(
      runSelfHostedSmoke(readSmokeConfig(fixtureEnv), { fetch: fixture.fetch }),
    ).rejects.toThrow("mailpit guard");
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.users).toHaveLength(0);
  });

  test("does not retry a failed mutation or leak its remote error details", async () => {
    const fixture = httpFixture({
      override: (request) =>
        new URL(request.url).pathname === "/trpc/team.create"
          ? Response.json({ error: privateMarker }, { status: 503 })
          : undefined,
    });
    let output = "";
    try {
      await runSelfHostedSmoke(readSmokeConfig(fixtureEnv), {
        fetch: fixture.fetch,
      });
      throw new Error("Expected runner failure");
    } catch (error) {
      output = JSON.stringify(smokeFailureOutput(error));
    }
    expect(output).toContain("team.create");
    expect(output).toContain("503");
    expect(output).not.toContain(privateMarker);
    expect(output).not.toContain("123456");
    expect(output).not.toContain(fixture.users[0]!.token);
    expect(
      fixture.calls.filter(
        (request) => new URL(request.url).pathname === "/trpc/team.create",
      ),
    ).toHaveLength(1);
  });

  test.each([
    { profileLeak: true },
    { projectLeak: true },
    { switchStatus: 500 },
  ])("does not misclassify a data leak/server failure as tenant denial %j", async (options) => {
    const fixture = httpFixture(options);
    await expect(
      runSelfHostedSmoke(readSmokeConfig(fixtureEnv), { fetch: fixture.fetch }),
    ).rejects.toThrow();
  });

  test("Mailpit receive polling ends without resending OTP or reading an unrelated message", async () => {
    const fixture = httpFixture({
      override: (request) =>
        new URL(request.url).pathname === "/api/v1/search"
          ? Response.json({
              messages: [
                {
                  ID: "unrelated",
                  To: [{ Address: "not-this-run@example.test" }],
                },
              ],
            })
          : undefined,
    });
    await expect(
      runSelfHostedSmoke(readSmokeConfig(fixtureEnv), {
        fetch: fixture.fetch,
        timeouts: { otpMs: 15, pollMs: 2 },
      }),
    ).rejects.toThrow("OTP delivery deadline");
    expect(
      fixture.calls.filter(
        (request) => new URL(request.url).pathname === "/auth/v1/otp",
      ),
    ).toHaveLength(1);
    expect(
      fixture.calls.some((request) => request.url.includes("/api/v1/message/")),
    ).toBe(false);
  });

  test.each([
    { requestMs: 10, totalMs: 100 },
    { requestMs: 100, totalMs: 10 },
  ])("abort deadlines interrupt a stalled request %j", async (timeouts) => {
    const started = Date.now();
    await expect(
      runSelfHostedSmoke(readSmokeConfig(fixtureEnv), {
        timeouts,
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () => reject(new Error(privateMarker)),
              { once: true },
            );
          }),
      }),
    ).rejects.toThrow(/deadline|timeout/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("malformed/oversized HTTP responses and unknown exceptions are sanitized", async () => {
    for (const response of [
      new Response(privateMarker),
      new Response("x".repeat(1024 * 1024 + 1)),
    ]) {
      try {
        await runSelfHostedSmoke(readSmokeConfig(fixtureEnv), {
          fetch: async () => response,
        });
        throw new Error("Expected runner failure");
      } catch (error) {
        expect(JSON.stringify(smokeFailureOutput(error))).not.toContain(
          privateMarker,
        );
        expect(JSON.stringify(smokeFailureOutput(error))).toContain(
          "mailpit guard",
        );
      }
    }
    expect(
      JSON.stringify(smokeFailureOutput(new Error(privateMarker))),
    ).not.toContain(privateMarker);
  });
});

function runNode(args: string[], env: Record<string, string>) {
  const script = fileURLToPath(
    new URL("./self-hosted-smoke.mts", import.meta.url),
  );
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        "node",
        [...args, script, "--allow-test-writes"],
        {
          env: { PATH: process.env.PATH ?? "", ...env },
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

async function listenFixture(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No fixture port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeFixture(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("Node 24 CLI over disposable loopback HTTP fixtures", () => {
  test("loads a private --env-file and exercises native fetch without logging tokens or OTP", async () => {
    const fixture = httpFixture();
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(",") : value);
        }
        const result = await fixture.fetch(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers,
          ...(["GET", "HEAD"].includes(request.method ?? "GET")
            ? {}
            : { body: Buffer.concat(chunks) }),
        });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: privateMarker }));
      }
    });
    const temporary = mkdtempSync(join(tmpdir(), "agsaas-smoke-cli-test-"));
    try {
      const base = await listenFixture(server);
      const envFile = join(temporary, "fixture.env");
      writeFileSync(
        envFile,
        Object.entries({
          ...fixtureEnv,
          SUPABASE_PUBLIC_URL: base,
          AGSAAS_API_URL: base,
          SELF_HOSTED_SMOKE_MAILPIT_URL: base,
        })
          .map(([name, value]) => `${name}=${value}`)
          .join("\n"),
        { mode: 0o600 },
      );
      const result = await runNode([`--env-file=${envFile}`], {});
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).status).toBe("passed");
      expect(fixture.users).toHaveLength(2);
      for (const secret of [
        publishable,
        privateMarker,
        "123456",
        ...fixture.users.flatMap((user) => [user.email, user.token]),
      ]) {
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
    } finally {
      await closeFixture(server);
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 10_000);

  test("native fetch refuses redirects instead of forwarding a key/token to a second origin", async () => {
    let destinationRequests = 0;
    const destination = createServer((_request, response) => {
      destinationRequests++;
      response.end("unexpected");
    });
    let destinationBase = "";
    const redirect = createServer((_request, response) => {
      response.writeHead(302, {
        location: `${destinationBase}/${privateMarker}`,
      });
      response.end();
    });
    try {
      destinationBase = await listenFixture(destination);
      const redirectBase = await listenFixture(redirect);
      const result = await runNode([], {
        ...fixtureEnv,
        SELF_HOSTED_SMOKE_MAILPIT_URL: redirectBase,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toContain("redirect failure");
      expect(result.stderr).not.toContain(privateMarker);
      expect(destinationRequests).toBe(0);
    } finally {
      await Promise.all([closeFixture(redirect), closeFixture(destination)]);
    }
  }, 10_000);
});
