import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  assertCaptureOnlyMailpit,
  extractMailpitOtp,
  loopbackBaseUrl,
  parseSmokeArguments,
  readSmokeConfig,
  type SmokeConfig,
} from "./self-hosted-smoke.mts";

/**
 * Destructive only to this run's freshly generated, empty, sole-owner account.
 * Run on the isolated matched-stack clone with its actual runtime environment:
 * node --env-file=/private/clone/.env scripts/self-hosted-account-smoke.mts --allow-test-writes
 *
 * Auth issues a real user session after SMTP OTP. No admin key, SQL, mocked
 * application import, pre-existing fixture, payment or external job is used.
 * The runner cannot attest a remote process's environment: the operator must
 * confirm the loaded file matches the API and that optional Resend cleanup is
 * disabled there. This does not test external provider cleanup or shared-team
 * last-owner deletion: team.invite currently calls Trigger.dev.
 *
 * A successful matched-stack profile check is meaningful because baseline
 * agsaas_profile_read uses only id=auth.uid(), not a deletion/member predicate.
 * The old JWT must still be valid; HTTP 401, hidden tombstones under different
 * policies, and arbitrary Auth errors are not accepted as deletion evidence.
 * Auth user_not_found: https://supabase.com/docs/guides/auth/debugging/error-codes
 * No mutation is retried and no failure cleanup deletes unconfirmed fixtures.
 */

type JsonObject = Record<string, unknown>;
type Environment = Record<string, string | undefined>;
type AccountSmokeFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AccountSmokeConfig = SmokeConfig & {
  marketingCleanupDisabled: true;
};

export type AccountSmokeReport = {
  status: "running" | "passed" | "failed";
  runId: string;
  checks: string[];
  fixture: {
    identityId: string;
    userId?: string;
    teamId?: string;
    deletionState: "not-started" | "requested" | "api-confirmed" | "verified";
  };
  scope: "new-empty-sole-owner-account";
  sharedLastOwner: "not-exercised-trigger-provider-required";
  externalEmailDelivery: false;
  capturedMailRetained: true;
};

type AccountSmokeOptions = {
  allowTestWrites?: boolean;
  fetch?: AccountSmokeFetch;
  signal?: AbortSignal;
  // Offline tests may only shorten deadlines. No CLI timeout override exists.
  timeouts?: {
    requestMs?: number;
    otpMs?: number;
    totalMs?: number;
    pollMs?: number;
  };
};

class AccountSmokeError extends Error {
  report?: AccountSmokeReport;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function fail(step: string, reason: string): never {
  // Both strings are runner-owned labels; never pass remote error text here.
  throw new AccountSmokeError(`${step}: ${reason}`);
}

function check(condition: unknown, step: string): asserts condition {
  if (!condition) fail(step, "assertion failed");
}

function object(value: unknown, step: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(step, "unexpected response shape");
  }
  return value as JsonObject;
}

function identifier(value: unknown, step: string): string {
  check(typeof value === "string" && UUID.test(value), step);
  return value;
}

export function parseAccountSmokeArguments(args: string[]): "help" | "run" {
  try {
    return parseSmokeArguments(args);
  } catch {
    fail(
      "configuration",
      "explicit --allow-test-writes is required; no other flags are accepted",
    );
  }
}

export function readAccountSmokeConfig(env: Environment): AccountSmokeConfig {
  // Deletion has optional marketing cleanup. For this provider-free smoke,
  // require BOTH fields absent, even though either missing disables it today.
  if (env.RESEND_API_KEY?.trim() || env.RESEND_AUDIENCE_ID?.trim()) {
    fail(
      "configuration",
      "Resend key and audience must be unset in the clone runtime environment",
    );
  }
  try {
    return { ...readSmokeConfig(env), marketingCleanupDisabled: true };
  } catch {
    fail(
      "configuration",
      "loopback origins, a publishable key and the capture-only Mailpit overlay are required",
    );
  }
}

function shorterTimeout(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  check(
    Number.isInteger(value) && value >= 1 && value <= maximum,
    "test timeout configuration",
  );
  return value;
}

async function readJson(response: Response, step: string): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) fail(step, "empty HTTP response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
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

function freshUserJwt(
  token: unknown,
  userId: string,
  email: string,
): asserts token is string {
  check(
    typeof token === "string" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token),
    "Auth session token",
  );
  let claims: JsonObject;
  try {
    claims = object(
      JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
      ),
      "Auth token claims",
    );
  } catch {
    fail("Auth token claims", "invalid JWT payload");
  }
  // This is a freshness/identity guard, not local JWT authentication. Auth,
  // PostgREST and the application each independently verify the actual token.
  check(
    claims.sub === userId &&
      claims.email === email &&
      claims.role === "authenticated" &&
      typeof claims.exp === "number" &&
      Number.isSafeInteger(claims.exp) &&
      claims.exp > Math.floor(Date.now() / 1000) + 180,
    "fresh unexpired user JWT",
  );
}

export async function runSelfHostedAccountSmoke(
  config: AccountSmokeConfig,
  options: AccountSmokeOptions = {},
): Promise<AccountSmokeReport> {
  check(options.allowTestWrites === true, "explicit test writes permission");
  try {
    loopbackBaseUrl(config.supabaseUrl, "Supabase origin");
    loopbackBaseUrl(config.apiUrl, "API origin");
    loopbackBaseUrl(config.mailpitUrl, "Mailpit origin");
  } catch {
    fail(
      "configuration",
      "only literal credential-free loopback base URLs are allowed",
    );
  }
  check(
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey) &&
      config.marketingCleanupDisabled === true,
    "publishable key and disabled provider cleanup configuration",
  );
  const requestMs = shorterTimeout(options.timeouts?.requestMs, 15_000);
  const otpMs = shorterTimeout(options.timeouts?.otpMs, 30_000);
  const totalMs = shorterTimeout(options.timeouts?.totalMs, 120_000);
  const pollMs = shorterTimeout(options.timeouts?.pollMs, 500);
  const signal = AbortSignal.any([
    AbortSignal.timeout(totalMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const fetcher = options.fetch ?? globalThis.fetch;
  const report: AccountSmokeReport = {
    status: "running",
    runId: randomUUID(),
    checks: [],
    fixture: { identityId: randomUUID(), deletionState: "not-started" },
    scope: "new-empty-sole-owner-account",
    sharedLastOwner: "not-exercised-trigger-provider-required",
    externalEmailDelivery: false,
    capturedMailRetained: true,
  };
  const email = `smoke-${report.fixture.identityId}@example.test`;
  const name = `Account smoke ${report.runId}`;

  async function request(step: string, url: URL, init: RequestInit = {}) {
    if (signal.aborted) fail(step, "total deadline or cancellation");
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
      if (error instanceof AccountSmokeError) throw error;
      fail(
        step,
        signal.aborted
          ? "total deadline or cancellation"
          : "network, timeout or redirect failure",
      );
    }
  }

  async function ok(step: string, url: URL, init?: RequestInit) {
    const response = await request(step, url, init);
    if (response.status < 200 || response.status >= 300)
      fail(step, `HTTP ${response.status}`);
    return response.body;
  }

  function authHeaders(token?: string): Record<string, string> {
    return {
      apikey: config.publishableKey,
      "Content-Type": "application/json",
      // Match the installed auth-js wire protocol, including string error codes.
      "X-Supabase-Api-Version": "2024-01-01",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async function trpc(
    token: string,
    path:
      | "user.me"
      | "user.delete"
      | "team.create"
      | "team.current"
      | "team.list"
      | "team.members",
    input?: JsonObject,
    mutation = false,
    expectMissing = false,
  ) {
    const response = await request(
      path,
      new URL(`/trpc/${path}`, config.apiUrl),
      {
        method: mutation ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-force-primary": "true",
        },
        ...(mutation ? { body: JSON.stringify({ json: input ?? null }) } : {}),
      },
    );
    const body = object(response.body, path);
    if (expectMissing) {
      const error = object(object(body.error, path).json, path);
      check(
        response.status === 404 &&
          object(error.data, path).code === "NOT_FOUND",
        "deleted account API access denied",
      );
      return;
    }
    if (response.status !== 200 || body.error)
      fail(path, `HTTP ${response.status} or tRPC failure`);
    return object(object(body.result, path).data, path).json;
  }

  async function profileRows(token: string, id: string) {
    const url = new URL("/rest/v1/users", config.supabaseUrl);
    url.searchParams.set("select", "id,email,full_name,team_id");
    url.searchParams.set("id", `eq.${id}`);
    url.searchParams.set("limit", "2");
    const rows = await ok("PostgREST own profile", url, {
      headers: authHeaders(token),
    });
    check(Array.isArray(rows), "PostgREST own profile");
    return rows;
  }

  async function awaitOtp() {
    const deadline = Date.now() + otpMs;
    const otpSignal = AbortSignal.any([signal, AbortSignal.timeout(otpMs)]);
    while (Date.now() < deadline) {
      const url = new URL("/api/v1/search", config.mailpitUrl);
      url.searchParams.set("query", `to:"${email}"`);
      url.searchParams.set("limit", "5");
      const body = object(
        await ok("mailpit search", url, { signal: otpSignal }),
        "mailpit search",
      );
      check(Array.isArray(body.messages), "mailpit search");
      const messages = body.messages.filter((value) => {
        const message = object(value, "mailpit search");
        return (
          Array.isArray(message.To) &&
          message.To.length === 1 &&
          object(message.To[0], "mailpit recipient").Address === email &&
          [message.Cc, message.Bcc].every(
            (other) =>
              other == null || (Array.isArray(other) && other.length === 0),
          )
        );
      });
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
        try {
          return extractMailpitOtp(message, email);
        } catch {
          fail("mailpit OTP", "unexpected recipient or ambiguous code");
        }
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

  try {
    const capture = await ok(
      "mailpit guard",
      new URL("/api/v1/webui", config.mailpitUrl),
    );
    try {
      assertCaptureOnlyMailpit(capture);
    } catch {
      fail("mailpit guard", "capture-only configuration required");
    }
    const ready = object(
      await ok("API readiness", new URL("/health/ready", config.apiUrl)),
      "API readiness",
    );
    check(ready.status === "ok", "API readiness");
    report.checks.push("capture-only Mailpit and API ready");

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
    const otp = await awaitOtp();
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
    const user = object(session.user, "Auth user");
    const userId = identifier(user.id, "Auth user ID");
    check(
      user.email === email &&
        typeof user.email_confirmed_at === "string" &&
        Number.isFinite(Date.parse(user.email_confirmed_at)),
      "Auth confirmed own email",
    );
    check(session.token_type === "bearer", "Auth token type");
    const token = session.access_token;
    freshUserJwt(token, userId, email);
    report.fixture.userId = userId;
    const authUser = object(
      await ok(
        "Auth getUser before deletion",
        new URL("/auth/v1/user", config.supabaseUrl),
        { headers: authHeaders(token) },
      ),
      "Auth getUser before deletion",
    );
    check(
      authUser.id === userId && authUser.email === email,
      "Auth own user before deletion",
    );
    report.checks.push("real SMTP OTP and Auth-issued user session verified");

    const rows = await profileRows(token, userId);
    check(rows.length === 1, "own initial profile");
    const profile = object(rows[0], "own initial profile");
    check(
      profile.id === userId &&
        profile.email === email &&
        profile.full_name === name &&
        profile.team_id === null,
      "new own profile without a team",
    );
    const apiUser = object(await trpc(token, "user.me"), "API own profile");
    check(
      apiUser.id === userId &&
        apiUser.email === email &&
        apiUser.teamId === null,
      "API own profile",
    );
    const initialTeams = await trpc(token, "team.list");
    check(
      Array.isArray(initialTeams) && initialTeams.length === 0,
      "new account has no existing teams",
    );
    report.checks.push("new Auth trigger profile and empty account confirmed");

    const teamId = identifier(
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
      "new team ID",
    );
    report.fixture.teamId = teamId;
    const current = object(
      await trpc(token, "team.current"),
      "new current team",
    );
    check(current.id === teamId && current.name === name, "new current team");
    const teams = await trpc(token, "team.list");
    check(
      Array.isArray(teams) && teams.length === 1,
      "only this run's new team exists",
    );
    const soleTeam = object(teams[0], "sole owned team");
    check(
      soleTeam.id === teamId &&
        soleTeam.name === name &&
        soleTeam.role === "owner",
      "sole owned team",
    );
    const members = await trpc(token, "team.members");
    check(
      Array.isArray(members) && members.length === 1,
      "sole member before deletion",
    );
    const member = object(members[0], "sole owner membership");
    const memberUser = object(member.user, "sole owner profile");
    check(
      member.teamId === teamId &&
        member.role === "owner" &&
        memberUser.id === userId &&
        memberUser.email === email,
      "sole owner membership",
    );
    report.checks.push(
      "only own fresh team and sole-owner membership confirmed",
    );

    freshUserJwt(token, userId, email);
    report.fixture.deletionState = "requested";
    const deleted = object(
      await trpc(token, "user.delete", undefined, true),
      "account deletion result",
    );
    check(deleted.id === userId, "account deletion result");
    report.fixture.deletionState = "api-confirmed";
    report.checks.push(
      "user.delete completed through the authenticated application API",
    );

    const missing = await request(
      "Auth getUser after deletion",
      new URL("/auth/v1/user", config.supabaseUrl),
      { headers: authHeaders(token) },
    );
    check(
      [401, 403].includes(missing.status) &&
        object(missing.body, "Auth missing user").code === "user_not_found",
      "Auth confirms user no longer exists",
    );
    freshUserJwt(token, userId, email);
    check(
      (await profileRows(token, userId)).length === 0,
      "own profile removed with still-unexpired JWT",
    );
    await trpc(token, "user.me", undefined, false, true);
    report.checks.push(
      "Auth user_not_found, own-profile absence and API NOT_FOUND verified with old unexpired JWT",
    );
    report.fixture.deletionState = "verified";
    report.status = "passed";
    return report;
  } catch (error) {
    report.status = "failed";
    const safe =
      error instanceof AccountSmokeError
        ? error
        : new AccountSmokeError(
            "account smoke: unexpected failure; private diagnostics suppressed",
          );
    safe.report = report;
    throw safe;
  }
}

export function accountSmokeFailureOutput(error: unknown): object {
  return {
    status: "failed",
    error:
      error instanceof AccountSmokeError
        ? error.message
        : "account smoke: unexpected failure; private diagnostics suppressed",
    ...(error instanceof AccountSmokeError && error.report
      ? { report: error.report }
      : {}),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (parseAccountSmokeArguments(process.argv.slice(2)) === "help") {
      console.log(
        "Node 24: node --env-file=/private/clone/.env scripts/self-hosted-account-smoke.mts --allow-test-writes\nIsolated matched-stack clone only. Requires literal loopback SUPABASE_PUBLIC_URL, AGSAAS_API_URL and SELF_HOSTED_SMOKE_MAILPIT_URL (default http://127.0.0.1:3825); SUPABASE_PUBLISHABLE_KEY; SMTP_HOST=mailpit; SMTP_PORT=1025; ENABLE_EMAIL_AUTOCONFIRM=false; RESEND_API_KEY and RESEND_AUDIENCE_ID unset in the actual API runtime. Creates and deletes only one fresh empty sole-owner account through real SMTP OTP and user.delete. No shared-team, payment or provider coverage. Captured OTP mail is retained. On any failure, stops without retrying mutations or deleting unconfirmed fixtures; report contains only their UUIDs.",
      );
    } else {
      console.log(
        JSON.stringify(
          await runSelfHostedAccountSmoke(readAccountSmokeConfig(process.env), {
            allowTestWrites: true,
          }),
        ),
      );
    }
  } catch (error) {
    console.error(JSON.stringify(accountSmokeFailureOutput(error)));
    process.exitCode = 1;
  }
}
