import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

/**
 * Closed-stage HTTP smoke, not a production account/bootstrap tool.
 *
 * Node 24: node --env-file=/private/runtime/.env scripts/self-hosted-smoke.mts --allow-test-writes
 * Uses only a publishable key and Auth-issued user tokens. No app imports, SDK
 * mocks, admin-generated OTPs, database credentials, or provider calls.
 * Fixtures are deliberately retained: existing user/team deletion routes have
 * external side effects. Mutations are never retried after an uncertain result.
 *
 * Protocol references: Supabase auth-email-passwordless docs and the installed
 * auth-js signInWithOtp/verifyOtp implementations; Mailpit v1 API swagger at
 * https://mailpit.axllent.org/docs/api-v1/ (search/message/webui endpoints).
 */

type Environment = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;
type SmokeFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type SmokeConfig = {
  supabaseUrl: string;
  apiUrl: string;
  mailpitUrl: string;
  publishableKey: string;
};

type FixtureIds = {
  identityId: string;
  userId?: string;
  teamId?: string;
  projectId?: string;
  entryId?: string;
};

export type SmokeReport = {
  status: "running" | "passed" | "failed";
  runId: string;
  checks: string[];
  fixtures: FixtureIds[];
  fixturesRetained: true;
  customerMode: "read-only";
  externalEmailDelivery: false;
};

type SmokeOptions = {
  fetch?: SmokeFetch;
  signal?: AbortSignal;
  // Tests may shorten deadlines. The CLI never accepts timeout overrides.
  timeouts?: {
    requestMs?: number;
    otpMs?: number;
    totalMs?: number;
    pollMs?: number;
  };
};

export class SelfHostedSmokeError extends Error {
  report?: SmokeReport;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAILPIT_LABEL = "AGSaaS private stage - captured test mail only";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function fail(step: string, reason: string): never {
  // Both arguments are runner-owned labels, never a remote body/error/URL.
  throw new SelfHostedSmokeError(`${step}: ${reason}`);
}

function object(value: unknown, step: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(step, "unexpected response shape");
  }
  return value as JsonObject;
}

function identifier(value: unknown, step: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail(step, "expected a UUID identifier");
  }
  return value;
}

function check(condition: unknown, step: string): asserts condition {
  if (!condition) fail(step, "assertion failed");
}

/** Literal loopback only: no LAN, Docker hostname, credentials, or base path. */
export function loopbackBaseUrl(
  value: string | undefined,
  name: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value ?? "");
  } catch {
    fail(name, "a loopback HTTP(S) base URL is required");
  }
  if (
    !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/.test(
      value ?? "",
    ) ||
    !["http:", "https:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    value !== value?.trim()
  ) {
    fail(name, "only a credential-free loopback base URL is allowed");
  }
  return parsed.origin;
}

export function parseSmokeArguments(args: string[]): "help" | "run" {
  if (args.length === 1 && args[0] === "--help") return "help";
  if (args.length !== 1 || args[0] !== "--allow-test-writes") {
    fail(
      "configuration",
      "explicit --allow-test-writes is required; no other flags are accepted",
    );
  }
  return "run";
}

function assertPublishableKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)
  ) {
    fail(
      "configuration",
      "SUPABASE_PUBLISHABLE_KEY must be a publishable key, never a server/admin key",
    );
  }
}

export function readSmokeConfig(env: Environment): SmokeConfig {
  // The private Compose overlay must be in use; never enable auto-confirm or
  // silently fall back to an external SMTP service for a successful smoke.
  if (
    env.SMTP_HOST !== "mailpit" ||
    env.SMTP_PORT !== "1025" ||
    env.ENABLE_EMAIL_AUTOCONFIRM !== "false"
  ) {
    fail(
      "configuration",
      "the capture-only Mailpit SMTP overlay with auto-confirm disabled is required",
    );
  }
  assertPublishableKey(env.SUPABASE_PUBLISHABLE_KEY);
  return {
    supabaseUrl: loopbackBaseUrl(
      env.SUPABASE_PUBLIC_URL,
      "SUPABASE_PUBLIC_URL",
    ),
    apiUrl: loopbackBaseUrl(env.AGSAAS_API_URL, "AGSAAS_API_URL"),
    mailpitUrl: loopbackBaseUrl(
      env.SELF_HOSTED_SMOKE_MAILPIT_URL ?? "http://127.0.0.1:3825",
      "SELF_HOSTED_SMOKE_MAILPIT_URL",
    ),
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
  };
}

export function assertCaptureOnlyMailpit(value: unknown): void {
  const configuration = object(value, "mailpit guard");
  const relay = object(configuration.MessageRelay, "mailpit guard");
  check(
    configuration.Label === MAILPIT_LABEL &&
      relay.Enabled === false &&
      !relay.SMTPServer,
    "mailpit guard",
  );
}

function addressedOnlyTo(value: JsonObject, email: string): boolean {
  const recipients = value.To;
  if (!Array.isArray(recipients) || recipients.length !== 1) return false;
  const recipient = recipients[0];
  if (recipient === null || typeof recipient !== "object") return false;
  if (!("Address" in recipient) || recipient.Address !== email) return false;
  return [value.Cc, value.Bcc].every(
    (other) => other == null || (Array.isArray(other) && other.length === 0),
  );
}

/** Read only the one message addressed to this run's generated test identity. */
export function extractMailpitOtp(value: unknown, email: string): string {
  const message = object(value, "mailpit OTP");
  check(
    email.startsWith("smoke-") &&
      email.endsWith("@example.test") &&
      UUID.test(email.slice(6, -13)),
    "mailpit OTP identity",
  );
  check(addressedOnlyTo(message, email), "mailpit OTP recipient");
  const text = typeof message.Text === "string" ? message.Text : "";
  const html = typeof message.HTML === "string" ? message.HTML : "";
  // Never execute/render HTML or follow links. Ignore script/style/attributes.
  const visibleHtml = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const codes = new Set(`${text}\n${visibleHtml}`.match(/\b\d{6}\b/g) ?? []);
  check(codes.size === 1, "mailpit OTP code");
  return [...codes][0]!;
}

function shorterTimeout(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    fail("configuration", "test timeouts may only shorten the fixed deadlines");
  }
  return value;
}

async function readJson(response: Response, step: string): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) fail(step, "empty HTTP response");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail(step, "HTTP response exceeds the smoke size limit");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(step, "invalid JSON response");
  }
}

export async function runSelfHostedSmoke(
  config: SmokeConfig,
  options: SmokeOptions = {},
): Promise<SmokeReport> {
  // Revalidate destinations even when called programmatically rather than CLI.
  loopbackBaseUrl(config.supabaseUrl, "SUPABASE_PUBLIC_URL");
  loopbackBaseUrl(config.apiUrl, "AGSAAS_API_URL");
  loopbackBaseUrl(config.mailpitUrl, "SELF_HOSTED_SMOKE_MAILPIT_URL");
  assertPublishableKey(config.publishableKey);
  const requestMs = shorterTimeout(options.timeouts?.requestMs, 10_000);
  const otpMs = shorterTimeout(options.timeouts?.otpMs, 30_000);
  const pollMs = shorterTimeout(options.timeouts?.pollMs, 500);
  const totalMs = shorterTimeout(options.timeouts?.totalMs, 120_000);
  const signal = AbortSignal.any([
    AbortSignal.timeout(totalMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const fetcher = options.fetch ?? globalThis.fetch;
  const report: SmokeReport = {
    status: "running",
    runId: randomUUID(),
    checks: [],
    fixtures: [],
    fixturesRetained: true,
    customerMode: "read-only",
    externalEmailDelivery: false,
  };
  const date = new Date().toISOString().slice(0, 10);

  async function request(
    step: string,
    url: URL,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> {
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(requestMs),
          ...(init.signal ? [init.signal] : []),
        ]),
      });
      return { status: response.status, body: await readJson(response, step) };
    } catch (error) {
      if (error instanceof SelfHostedSmokeError) throw error;
      // Native fetch/JSON errors may contain URLs, tokens or response snippets.
      fail(
        step,
        signal.aborted
          ? "total deadline or cancellation"
          : "network, timeout or redirect failure",
      );
    }
  }

  async function ok(
    step: string,
    url: URL,
    init?: RequestInit,
  ): Promise<unknown> {
    const response = await request(step, url, init);
    if (response.status < 200 || response.status >= 300) {
      fail(step, `HTTP ${response.status}`);
    }
    return response.body;
  }

  function authHeaders(token?: string): Record<string, string> {
    return {
      apikey: config.publishableKey,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async function trpc(
    token: string,
    path: string,
    input: JsonObject | undefined,
    mutation = false,
    forbidden = false,
  ): Promise<unknown> {
    const url = new URL(`/trpc/${path}`, config.apiUrl);
    const encoded =
      input === undefined ? undefined : JSON.stringify({ json: input });
    if (!mutation && encoded) url.searchParams.set("input", encoded);
    const response = await request(path, url, {
      method: mutation ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-force-primary": "true",
      },
      ...(mutation ? { body: encoded ?? JSON.stringify({ json: null }) } : {}),
    });
    const body = object(response.body, path);
    if (forbidden) {
      const error = object(object(body.error, path).json, path);
      check(
        response.status === 403 &&
          object(error.data, path).code === "FORBIDDEN",
        `${path} denial`,
      );
      return;
    }
    if (response.status !== 200 || body.error)
      fail(path, `HTTP ${response.status} or tRPC failure`);
    const result = object(body.result, path);
    return object(result.data, path).json;
  }

  async function dataApi(
    token: string,
    table: "users" | "teams",
    id: string,
  ): Promise<unknown[]> {
    const url = new URL(`/rest/v1/${table}`, config.supabaseUrl);
    url.searchParams.set(
      "select",
      table === "users" ? "id,email,full_name,team_id" : "id,name",
    );
    url.searchParams.set("id", `eq.${id}`);
    url.searchParams.set("limit", "2");
    const rows = await ok(`PostgREST ${table}`, url, {
      headers: authHeaders(token),
    });
    check(Array.isArray(rows), `PostgREST ${table}`);
    return rows;
  }

  async function awaitOtp(email: string): Promise<string> {
    const deadline = Date.now() + otpMs;
    const otpSignal = AbortSignal.any([signal, AbortSignal.timeout(otpMs)]);
    while (Date.now() < deadline) {
      const url = new URL("/api/v1/search", config.mailpitUrl);
      url.searchParams.set("query", `to:"${email}"`);
      url.searchParams.set("limit", "5");
      const response = object(
        await ok("mailpit search", url, { signal: otpSignal }),
        "mailpit search",
      );
      check(Array.isArray(response.messages), "mailpit search");
      const messages = response.messages.filter((value) =>
        addressedOnlyTo(object(value, "mailpit search"), email),
      );
      check(messages.length <= 1, "mailpit duplicate messages");
      if (messages.length === 1) {
        const id = object(messages[0], "mailpit message").ID;
        check(
          typeof id === "string" &&
            /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
            id !== "latest",
          "mailpit message ID",
        );
        const message = object(
          await ok(
            "mailpit message",
            new URL(`/api/v1/message/${id}`, config.mailpitUrl),
            { signal: otpSignal },
          ),
          "mailpit message",
        );
        check(message.ID === id, "mailpit message ID");
        return extractMailpitOtp(message, email);
      }
      try {
        await delay(
          Math.min(pollMs, Math.max(1, deadline - Date.now())),
          undefined,
          { signal },
        );
      } catch {
        fail("mailpit receive", "total deadline or cancellation");
      }
    }
    fail("mailpit receive", "OTP delivery deadline");
  }

  async function createTenant(label: "A" | "B") {
    const ids: FixtureIds = { identityId: randomUUID() };
    report.fixtures.push(ids);
    const email = `smoke-${ids.identityId}@example.test`;
    const name = `Smoke ${report.runId.slice(0, 8)} ${label}`;
    // Same wire operation as auth.signInWithOtp, without PKCE magic-link flow.
    await ok(
      "Auth signInWithOtp",
      new URL("/auth/v1/otp", config.supabaseUrl),
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          email,
          create_user: true,
          data: { full_name: name },
        }),
      },
    );
    const otp = await awaitOtp(email);
    const session = object(
      await ok(
        "Auth verifyOtp",
        new URL("/auth/v1/verify", config.supabaseUrl),
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ email, token: otp, type: "email" }),
        },
      ),
      "Auth verifyOtp",
    );
    const token = session.access_token;
    check(
      typeof token === "string" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token),
      "Auth session",
    );
    check(session.token_type === "bearer", "Auth session type");
    const user = object(session.user, "Auth user");
    ids.userId = identifier(user.id, "Auth user");
    check(
      user.email === email &&
        typeof user.email_confirmed_at === "string" &&
        Number.isFinite(Date.parse(user.email_confirmed_at)),
      "Auth confirmed email",
    );
    report.checks.push(`${label}: real SMTP OTP verified`);

    const profiles = await dataApi(token, "users", ids.userId);
    check(profiles.length === 1, "PostgREST own profile");
    const profile = object(profiles[0], "PostgREST own profile");
    check(
      profile.id === ids.userId &&
        profile.email === email &&
        profile.full_name === name &&
        profile.team_id === null,
      "PostgREST initial profile",
    );
    report.checks.push(`${label}: Auth profile trigger and own-profile RLS`);

    const apiProfile = object(
      await trpc(token, "user.me", undefined),
      "API initial profile",
    );
    check(
      apiProfile.id === ids.userId &&
        apiProfile.email === email &&
        apiProfile.teamId === null,
      "API initial profile",
    );
    ids.teamId = identifier(
      await trpc(
        token,
        "team.create",
        {
          name,
          baseCurrency: "USD",
          countryCode: "US",
          companyType: "solo_founder",
          heardAbout: "other",
          switchTeam: true,
        },
        true,
      ),
      "first team",
    );
    const current = object(
      await trpc(token, "team.current", undefined),
      "current team",
    );
    check(current.id === ids.teamId && current.name === name, "current team");
    const ownTeams = await dataApi(token, "teams", ids.teamId);
    check(
      ownTeams.length === 1 &&
        object(ownTeams[0], "own team RLS").id === ids.teamId,
      "own team RLS",
    );
    report.checks.push(`${label}: first team and own-team RLS`);

    // Normal customer creation auto-enqueues optional provider enrichment.
    // Test its real read query only; do not bypass that production behavior.
    const customers = object(
      await trpc(token, "customers.get", { pageSize: 5 }),
      "customers read",
    );
    check(
      Array.isArray(customers.data) && customers.data.length === 0,
      "new-team customers read",
    );
    report.checks.push(`${label}: customer list read`);

    const project = object(
      await trpc(
        token,
        "trackerProjects.upsert",
        {
          name,
          billable: true,
          rate: 120,
          currency: "USD",
        },
        true,
      ),
      "tracker project",
    );
    ids.projectId = identifier(project.id, "tracker project");
    check(
      project.teamId === ids.teamId && project.name === name,
      "tracker project ownership",
    );
    const entries = await trpc(
      token,
      "trackerEntries.upsert",
      {
        start: `${date}T10:00:00.000Z`,
        stop: `${date}T10:01:00.000Z`,
        dates: [date],
        duration: 60,
        assignedId: ids.userId,
        projectId: ids.projectId,
        description: "Closed-stage smoke fixture",
      },
      true,
    );
    check(
      Array.isArray(entries) && entries.length === 1,
      "tracker entry create",
    );
    const entry = object(entries[0], "tracker entry create");
    ids.entryId = identifier(entry.id, "tracker entry create");
    check(
      entry.projectId === ids.projectId &&
        entry.teamId === ids.teamId &&
        entry.assignedId === ids.userId &&
        entry.duration === 60,
      "tracker entry ownership",
    );
    report.checks.push(`${label}: tracker project and entry created`);
    return { token, ids, name };
  }

  try {
    assertCaptureOnlyMailpit(
      await ok("mailpit guard", new URL("/api/v1/webui", config.mailpitUrl)),
    );
    const ready = object(
      await ok("API readiness", new URL("/health/ready", config.apiUrl)),
      "API readiness",
    );
    check(ready.status === "ok", "API readiness");
    report.checks.push("capture-only Mailpit and API ready");

    const a = await createTenant("A");
    const b = await createTenant("B");
    for (const [own, other, label] of [
      [a, b, "A"],
      [b, a, "B"],
    ] as const) {
      check(
        (await dataApi(own.token, "users", other.ids.userId!)).length === 0,
        "cross-tenant profile RLS",
      );
      check(
        (await dataApi(own.token, "teams", other.ids.teamId!)).length === 0,
        "cross-tenant team RLS",
      );
      check(
        (await trpc(own.token, "trackerProjects.getById", {
          id: other.ids.projectId,
        })) === null,
        "cross-tenant project read",
      );
      await trpc(
        own.token,
        "user.switchTeam",
        { teamId: other.ids.teamId },
        true,
        true,
      );

      const profile = object(
        await trpc(own.token, "user.me", undefined),
        "profile after denial",
      );
      check(
        profile.id === own.ids.userId && profile.teamId === own.ids.teamId,
        "active team unchanged after denial",
      );
      const project = object(
        await trpc(own.token, "trackerProjects.getById", {
          id: own.ids.projectId,
        }),
        "own project after denial",
      );
      check(
        project.id === own.ids.projectId &&
          project.name === own.name &&
          project.teamId === own.ids.teamId &&
          Number(project.totalDuration) === 60 &&
          Number(project.totalAmount) === 2,
        "own project aggregates after denial",
      );
      const records = object(
        await trpc(own.token, "trackerEntries.byDate", { date }),
        "tracker records",
      );
      check(
        Array.isArray(records.data) && records.data.length === 1,
        "tracker records",
      );
      const entry = object(records.data[0], "tracker records");
      check(
        entry.id === own.ids.entryId &&
          entry.duration === 60 &&
          object(entry.trackerProject, "tracker relation").id ===
            own.ids.projectId &&
          object(entry.user, "tracker user").id === own.ids.userId &&
          object(records.meta, "tracker totals").totalDuration === 60,
        "tracker read and isolation",
      );
      report.checks.push(
        `${label}: cross-tenant RLS/API denial and unchanged own tracker totals`,
      );
    }
    report.status = "passed";
    return report;
  } catch (error) {
    report.status = "failed";
    const safe =
      error instanceof SelfHostedSmokeError
        ? error
        : new SelfHostedSmokeError(
            "smoke: unexpected failure; private diagnostics suppressed",
          );
    safe.report = report;
    throw safe;
  }
}

export function smokeFailureOutput(error: unknown): object {
  return {
    status: "failed",
    error:
      error instanceof SelfHostedSmokeError
        ? error.message
        : "smoke: unexpected failure; private diagnostics suppressed",
    ...(error instanceof SelfHostedSmokeError && error.report
      ? { report: error.report }
      : {}),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const mode = parseSmokeArguments(process.argv.slice(2));
    if (mode === "help") {
      console.log(
        "Node 24: node --env-file=/private/runtime/.env scripts/self-hosted-smoke.mts --allow-test-writes\nClosed-stage only. Requires SUPABASE_PUBLIC_URL, AGSAAS_API_URL, SUPABASE_PUBLISHABLE_KEY, SMTP_HOST=mailpit, SMTP_PORT=1025, ENABLE_EMAIL_AUTOCONFIRM=false. SELF_HOSTED_SMOKE_MAILPIT_URL defaults to http://127.0.0.1:3825. Creates two unique test users/teams/tracker fixtures and retains them. No external delivery, customer enrichment, storage or provider checks.",
      );
    } else {
      console.log(
        JSON.stringify(await runSelfHostedSmoke(readSmokeConfig(process.env))),
      );
    }
  } catch (error) {
    console.error(JSON.stringify(smokeFailureOutput(error)));
    process.exitCode = 1;
  }
}
