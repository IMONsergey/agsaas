import { mock } from "bun:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import type { NextRequest } from "next/server";
import { Cookies } from "../constants";

// Unit boundary tests, not a real Supabase login. Framework/Auth/API responses
// are local fakes and every mock lives only in this child process. No real
// credentials are inherited, no emails are sent, and network calls are errors.
const scenario = process.argv[2]!;
const origin = "http://127.0.0.1:3001";
let networkAttempts = 0;
const blockNetwork = (): never => {
  networkAttempts++;
  throw new Error("Network forbidden in auth handler fixture");
};
globalThis.fetch = Object.assign(async () => blockNetwork(), {
  preconnect: blockNetwork,
});
Socket.prototype.connect = blockNetwork;
Bun.connect = blockNetwork;

const session = {
  user: { id: "fixture-user", created_at: "2030-01-01T00:00:00.000Z" },
};
const cookieValues = new Map<string, unknown>();
const calls = {
  verifyOtp: [] as unknown[],
  exchangeCode: [] as string[],
  ambientSession: 0,
  signOut: 0,
  userQuery: 0,
};

if (scenario.endsWith("-waitlist")) {
  process.env.NEW_USER_SIGNUP_CUTOFF = "2026-04-20T00:00:00.000Z";
}

function authResponse() {
  if (scenario.endsWith("-throw")) throw new Error("private transport details");
  return {
    data: { session },
    error: scenario.endsWith("-error") ? new Error("private Auth error") : null,
  };
}

mock.module("@midday/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      verifyOtp: async (input: unknown) => {
        calls.verifyOtp.push(input);
        return authResponse();
      },
      exchangeCodeForSession: async (code: string) => {
        calls.exchangeCode.push(code);
        return authResponse();
      },
      getSession: async () => {
        calls.ambientSession++;
        return { data: { session }, error: null };
      },
      signOut: async () => {
        calls.signOut++;
      },
    },
  }),
}));
mock.module("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: unknown) => cookieValues.set(name, value),
  }),
}));
class RedirectSignal extends Error {
  constructor(readonly destination: string) {
    super("fixture redirect");
  }
}
mock.module("next/navigation", () => ({
  redirect: (destination: string): never => {
    throw new RedirectSignal(destination);
  },
}));
mock.module("@/actions/safe-action", () => ({
  actionClient: {
    schema: (schema: { parse: (input: unknown) => unknown }) => ({
      action:
        (handler: (args: { parsedInput: unknown }) => Promise<unknown>) =>
        (input: unknown) =>
          handler({ parsedInput: schema.parse(input) }),
    }),
  },
}));
mock.module("@/trpc/server", () => ({
  getTRPCClient: async () => ({
    user: {
      me: {
        query: async () => {
          calls.userQuery++;
          return scenario === "oauth-onboarding"
            ? { fullName: null, teamId: null }
            : { fullName: "Fixture User", teamId: "fixture-team" };
        },
      },
    },
  }),
}));
mock.module("@midday/events/server", () => ({
  setupAnalytics: async () => ({ track: () => {} }),
}));

const deadline = setTimeout(() => process.exit(124), 8000);
try {
  if (scenario.startsWith("otp-")) {
    const { verifyOtpAction } = await import("../../actions/verify-otp-action");
    const input = {
      email: "fixture@example.test",
      token: "123456",
      redirectTo: `${origin}/settings/accounts`,
    };
    if (scenario === "otp-error" || scenario === "otp-throw") {
      await assert.rejects(verifyOtpAction(input), {
        message:
          "Unable to verify the code. Please try again or request a new code.",
      });
      assert.equal(cookieValues.size, 0);
      assert.equal(calls.signOut, 0);
    } else {
      await assert.rejects(verifyOtpAction(input), (error: unknown) => {
        assert(error instanceof RedirectSignal);
        assert.equal(
          error.destination,
          scenario === "otp-waitlist"
            ? `${origin}/login?waitlist=1`
            : input.redirectTo,
        );
        return true;
      });
      if (scenario === "otp-waitlist") {
        assert.equal(calls.signOut, 1);
        assert.equal(cookieValues.size, 0);
      } else {
        assert.equal(calls.signOut, 0);
        assert.equal(cookieValues.get(Cookies.PreferredSignInProvider), "otp");
        assert.equal(cookieValues.get(Cookies.ForcePrimary), "true");
      }
    }
    assert.deepEqual(calls.verifyOtp, [
      { email: input.email, token: input.token, type: "email" },
    ]);
  } else {
    const { GET } = await import("../../app/api/auth/callback/route");
    const url = new URL("/api/auth/callback", origin);
    url.searchParams.set("provider", "google");
    url.searchParams.set("return_to", "settings/accounts");
    if (scenario !== "oauth-no-code")
      url.searchParams.set("code", "fixture-pkce-code");
    if (scenario === "oauth-provider-error") {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "private provider details");
    }
    if (scenario === "oauth-desktop") url.searchParams.set("client", "desktop");
    const response = await GET(new Request(url) as NextRequest);
    const expectedPaths: Record<string, string> = {
      "oauth-valid": "/settings/accounts",
      "oauth-onboarding": "/onboarding",
      "oauth-error": "/login?error=auth_callback",
      "oauth-throw": "/login?error=auth_callback",
      "oauth-no-code": "/login?error=auth_callback",
      "oauth-provider-error": "/login?error=auth_callback",
      "oauth-waitlist": "/login?waitlist=1",
      "oauth-desktop": "/verify?code=fixture-pkce-code",
    };
    const expectedPath = expectedPaths[scenario];
    assert(expectedPath, "unknown OAuth scenario");
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), `${origin}${expectedPath}`);
    const exchanged = ![
      "oauth-no-code",
      "oauth-provider-error",
      "oauth-desktop",
    ].includes(scenario);
    assert.deepEqual(
      calls.exchangeCode,
      exchanged ? ["fixture-pkce-code"] : [],
    );
    assert.equal(calls.signOut, scenario === "oauth-waitlist" ? 1 : 0);
    const authenticated =
      scenario === "oauth-valid" || scenario === "oauth-onboarding";
    assert.equal(calls.userQuery, authenticated ? 1 : 0);
    assert.equal(
      cookieValues.get(Cookies.ForcePrimary),
      authenticated ? "true" : undefined,
    );
  }
  assert.equal(
    calls.ambientSession,
    0,
    "must not reuse a stale ambient session after a failed Auth request",
  );
  assert.equal(networkAttempts, 0);
  console.log(`AUTH_HANDLERS_OK ${scenario} networkAttempts=0`);
} finally {
  clearTimeout(deadline);
}
