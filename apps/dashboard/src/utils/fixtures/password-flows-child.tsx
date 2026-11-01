import { mock } from "bun:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import type { NextRequest } from "next/server";
import type { ReactNode } from "react";

// These fixtures exercise the actual actions, callback and policy. Framework,
// Auth and API responses are isolated; no deployed credentials are inherited.
const scenario = process.argv[2]!;
const origin = "https://dashboard.example.test";
const userId = "11111111-1111-4111-8111-111111111111";
const user = { id: userId, email: "fixture@example.test" };
const now = Math.floor(Date.now() / 1000);
let networkAttempts = 0;
const blockNetwork = (): never => {
  networkAttempts++;
  throw new Error("Network forbidden in password fixture");
};
globalThis.fetch = Object.assign(async () => blockNetwork(), {
  preconnect: blockNetwork,
});
Socket.prototype.connect = blockNetwork;
Bun.connect = blockNetwork;
mock.module("server-only", () => ({}));
process.env.AUTH_ENABLED_PROVIDERS =
  scenario.endsWith("password-disabled") || scenario === "change-disabled"
    ? "email"
    : "password";
process.env.AUTH_PASSWORD_RECOVERY_ENABLED =
  scenario.endsWith("-disabled") || scenario.startsWith("change-")
    ? "false"
    : scenario === "request-nonliteral-flag"
      ? "yes"
      : "true";

const claims = {
  sub: userId,
  role: "authenticated",
  aud: "authenticated",
  exp: now + 3600,
  session_id: "22222222-2222-4222-8222-222222222222",
  amr: [
    {
      method:
        scenario.endsWith("password-amr") || scenario.endsWith("metadata-amr")
          ? "password"
          : "recovery",
      timestamp: scenario.endsWith("-expired") ? now - 901 : now,
    },
  ],
  user_metadata: { amr: [{ method: "recovery", timestamp: now }] },
};
const recoverySession = {
  user,
  access_token: "newly-exchanged-recovery-session",
};
const calls = {
  recover: [] as unknown[],
  exchange: [] as string[],
  claims: [] as unknown[],
  update: [] as unknown[],
  verify: [] as unknown[],
  originalLogout: [] as unknown[],
  verifierLogout: [] as unknown[],
  originalSignIn: 0,
  setSession: 0,
  ambientSession: 0,
  getUser: 0,
  profile: 0,
  revalidate: [] as string[],
};
const original = {
  auth: {
    resetPasswordForEmail: async (email: string, options: unknown) => {
      calls.recover.push({ email, options });
      if (scenario === "request-throw")
        throw new Error("PRIVATE_PROVIDER_DETAIL");
      return {
        data: {},
        error:
          scenario === "request-error"
            ? new Error("PRIVATE_PROVIDER_DETAIL")
            : null,
      };
    },
    exchangeCodeForSession: async (code: string) => {
      calls.exchange.push(code);
      if (scenario === "callback-throw")
        throw new Error("PRIVATE_PROVIDER_DETAIL");
      return {
        data: {
          session: scenario === "callback-no-session" ? null : recoverySession,
        },
        error:
          scenario === "callback-error"
            ? new Error("PRIVATE_PROVIDER_DETAIL")
            : null,
      };
    },
    getClaims: async (jwt?: string) => {
      calls.claims.push(jwt);
      return {
        data: { claims },
        error:
          scenario === "callback-claims-error"
            ? new Error("PRIVATE_PROVIDER_DETAIL")
            : null,
      };
    },
    getUser: async () => {
      calls.getUser++;
      return {
        data: { user: scenario.endsWith("-no-user") ? null : user },
        error: null,
      };
    },
    getSession: async () => {
      calls.ambientSession++;
      return { data: { session: recoverySession }, error: null };
    },
    updateUser: async (input: unknown) => {
      calls.update.push(input);
      if (scenario === "reset-throw" || scenario === "change-throw")
        throw new Error("PRIVATE_PROVIDER_DETAIL");
      return {
        data: { user },
        error: scenario.endsWith("-error")
          ? new Error("PRIVATE_PROVIDER_DETAIL")
          : null,
      };
    },
    signInWithPassword: async () => {
      calls.originalSignIn++;
      throw new Error("Must never downgrade the original MFA session");
    },
    setSession: async () => {
      calls.setSession++;
      throw new Error("Must never inject verifier session");
    },
    signOut: async (options: unknown) => {
      calls.originalLogout.push(options);
      if (scenario === "reset-logout-throw")
        throw new Error("PRIVATE_PROVIDER_DETAIL");
    },
  },
};

if (!scenario.startsWith("sdk-")) {
  mock.module("@midday/supabase/server", () => ({
    createClient: async () => original,
    createPasswordVerificationClient: () => ({
      auth: {
        signInWithPassword: async (input: unknown) => {
          calls.verify.push(input);
          if (scenario === "change-verifier-throw")
            throw new Error("PRIVATE_PROVIDER_DETAIL");
          return {
            data: {
              session:
                scenario === "change-no-session"
                  ? null
                  : {
                      user:
                        scenario === "change-wrong-user"
                          ? { ...user, id: "another-user" }
                          : user,
                    },
            },
            error:
              scenario === "change-verifier-error"
                ? new Error("PRIVATE_PROVIDER_DETAIL")
                : null,
          };
        },
        signOut: async (options: unknown) => {
          calls.verifierLogout.push(options);
        },
      },
    }),
  }));
}
mock.module("@/actions/safe-action", () => ({
  actionClient: {
    schema: (schema: { parse: (input: unknown) => unknown }) => ({
      action:
        (handler: (args: { parsedInput: unknown }) => Promise<unknown>) =>
        async (input: unknown) =>
          handler({ parsedInput: schema.parse(input) }),
    }),
  },
}));
mock.module("@/trpc/server", () => ({
  getTRPCClient: async (options: unknown) => {
    assert.deepEqual(options, { forcePrimary: true });
    return {
      user: {
        me: {
          query: async () => {
            calls.profile++;
            if (scenario.endsWith("-mfa-denied"))
              throw new Error("PRIVATE_MFA_API_DETAIL");
            return {
              id: userId,
              deletionStartedAt: scenario.endsWith("-deleting")
                ? "2026-01-01"
                : null,
            };
          },
        },
      },
    };
  },
}));
mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    calls.revalidate.push(path);
  },
}));

const deadline = setTimeout(() => process.exit(124), 8000);
try {
  if (scenario.startsWith("request-")) {
    const { requestPasswordRecoveryAction: action } = await import(
      "../../actions/request-password-recovery-action"
    );
    const disabled = [
      "request-disabled",
      "request-password-disabled",
      "request-nonliteral-flag",
    ].includes(scenario);
    if (disabled) {
      await assert.rejects(action({ email: user.email }), {
        message: "Password reset emails are not enabled for this installation.",
      });
      assert.deepEqual(calls.recover, []);
    } else {
      assert.deepEqual(await action({ email: user.email }), { accepted: true });
      assert.deepEqual(calls.recover, [
        {
          email: user.email,
          options: { redirectTo: `${origin}/api/auth/password-recovery` },
        },
      ]);
    }
  } else if (scenario.startsWith("callback-")) {
    const { GET } = await import("../../app/api/auth/password-recovery/route");
    const url = new URL("/api/auth/password-recovery", origin);
    // Neither a query-supplied recovery type nor redirect can grant access.
    url.searchParams.set("type", "recovery");
    url.searchParams.set("return_to", "https://untrusted.example.test");
    if (scenario !== "callback-no-code")
      url.searchParams.set("code", "fixture-pkce-code");
    if (scenario === "callback-provider-error")
      url.searchParams.set("error", "PRIVATE_PROVIDER_DETAIL");
    const response = await GET(new Request(url) as NextRequest);
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      `${origin}${scenario === "callback-valid" ? "/reset-password" : "/forgot-password?error=invalid_link"}`,
    );
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const attempted = ![
      "callback-no-code",
      "callback-disabled",
      "callback-provider-error",
    ].includes(scenario);
    assert.deepEqual(calls.exchange, attempted ? ["fixture-pkce-code"] : []);
    const exchanged =
      attempted &&
      !["callback-error", "callback-throw", "callback-no-session"].includes(
        scenario,
      );
    assert.deepEqual(
      calls.claims,
      exchanged ? [recoverySession.access_token] : [],
    );
    assert.deepEqual(
      calls.originalLogout,
      exchanged && scenario !== "callback-valid" ? [{ scope: "local" }] : [],
    );
    assert.equal(
      calls.profile,
      0,
      "MFA step-up happens after callback before final password form",
    );
  } else if (scenario.startsWith("reset-") || scenario.startsWith("change-")) {
    const reset = scenario.startsWith("reset-");
    const password = "new-fixture-password-only";
    const currentPassword =
      scenario === "change-same-password"
        ? password
        : "old-fixture-password-only";
    const invoke = reset
      ? () =>
          import("../../actions/reset-password-action").then(
            ({ resetPasswordAction }) => resetPasswordAction({ password }),
          )
      : () =>
          import("../../actions/change-password-action").then(
            ({ changePasswordAction }) =>
              changePasswordAction({ password, currentPassword }),
          );
    const success = [
      "reset-valid",
      "reset-logout-throw",
      "change-valid",
    ].includes(scenario);
    if (success) assert.deepEqual(await invoke(), { updated: true });
    else
      await assert.rejects(invoke(), (error: unknown) => {
        assert(error instanceof Error);
        assert(!error.message.includes("PRIVATE_"));
        assert(!error.message.includes(password));
        assert(!error.message.includes(currentPassword));
        return true;
      });
    const reachedWrite =
      success ||
      ["reset-error", "reset-throw", "change-error", "change-throw"].includes(
        scenario,
      );
    assert.deepEqual(
      calls.update,
      reachedWrite
        ? [
            reset
              ? { password }
              : { password, current_password: currentPassword },
          ]
        : [],
    );
    const verified =
      !reset &&
      ![
        "change-same-password",
        "change-no-user",
        "change-mfa-denied",
        "change-deleting",
        "change-disabled",
      ].includes(scenario);
    assert.deepEqual(
      calls.verify,
      verified ? [{ email: user.email, password: currentPassword }] : [],
    );
    assert.deepEqual(
      calls.verifierLogout,
      verified ? [{ scope: "local" }] : [],
    );
    assert.deepEqual(
      calls.originalLogout,
      reset && success ? [{ scope: "local" }] : [],
    );
    assert.deepEqual(
      calls.revalidate,
      scenario === "change-valid" ? ["/account/security"] : [],
    );
    // Recovery opt-in is deliberately false in all change-password cases.
    if (!reset)
      assert.equal(process.env.AUTH_PASSWORD_RECOVERY_ENABLED, "false");
  } else if (scenario === "validation") {
    const { changePasswordAction } = await import(
      "../../actions/change-password-action"
    );
    const { resetPasswordAction } = await import(
      "../../actions/reset-password-action"
    );
    for (const password of ["short", "a".repeat(129)]) {
      await assert.rejects(resetPasswordAction({ password }));
      await assert.rejects(
        changePasswordAction({ password, currentPassword: "fixture" }),
      );
    }
    await assert.rejects(
      changePasswordAction({
        password: "new-fixture-password",
        currentPassword: "",
      }),
    );
    assert.equal(calls.getUser, 0);
    assert.deepEqual(calls.update, []);
  } else if (scenario.startsWith("sdk-")) {
    const cookies = new Map<string, string>();
    let cookieWrites = 0;
    const cookieChanges: Array<{
      name: string;
      value: string;
      maxAge?: number;
      secure?: boolean;
    }> = [];
    const publicUrl = "https://supabase.example.test";
    const privateUrl = "http://auth.internal:8000";
    process.env.NEXT_PUBLIC_SUPABASE_URL = publicUrl;
    process.env.SUPABASE_INTERNAL_URL = privateUrl;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fixture-public-key";
    process.env.SUPABASE_SECRET_KEY = "must-never-be-used";
    mock.module("next/headers", () => ({
      cookies: async () => ({
        getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
        set: (
          name: string,
          value: string,
          options?: { maxAge?: number; secure?: boolean },
        ) => {
          cookieWrites++;
          cookieChanges.push({
            name,
            value,
            maxAge: options?.maxAge,
            secure: options?.secure,
          });
          if (options?.maxAge === 0) cookies.delete(name);
          else cookies.set(name, value);
        },
      }),
    }));
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwt = (aal: string, sessionId: string, method = "password") =>
      `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
        sub: userId,
        aal,
        session_id: sessionId,
        exp: now + 3600,
        role: "authenticated",
        aud: "authenticated",
        amr: [{ method, timestamp: now }],
      })}.c2lnbmF0dXJl`;
    const originalToken = jwt(
      "aal2",
      "33333333-3333-4333-8333-333333333333",
      "totp",
    );
    const verifierToken = jwt("aal1", "44444444-4444-4444-8444-444444444444");
    const recoveryToken = jwt(
      "aal1",
      "55555555-5555-4555-8555-555555555555",
      "recovery",
    );
    const authUser = {
      ...user,
      aud: "authenticated",
      created_at: "2026-01-01T00:00:00Z",
      app_metadata: {},
      user_metadata: {},
    };
    const sessionResponse = (access_token: string) =>
      Response.json({
        access_token,
        refresh_token: "fixture-refresh",
        token_type: "bearer",
        expires_in: 3600,
        user: authUser,
      });
    const requests: Array<{
      path: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.origin, privateUrl);
        assert.equal(request.headers.get("apikey"), "fixture-public-key");
        const body = request.method === "GET" ? null : await request.text();
        requests.push({
          path: url.pathname + url.search,
          authorization: request.headers.get("authorization"),
          body: body ? JSON.parse(body) : null,
        });
        if (url.pathname === "/auth/v1/verify")
          return sessionResponse(originalToken);
        if (url.pathname === "/auth/v1/recover") return Response.json({});
        if (url.pathname === "/auth/v1/token")
          return sessionResponse(
            url.searchParams.get("grant_type") === "pkce"
              ? recoveryToken
              : verifierToken,
          );
        if (url.pathname === "/auth/v1/user") return Response.json(authUser);
        if (url.pathname === "/auth/v1/logout" && url.search === "?scope=local")
          return new Response(null, { status: 204 });
        return blockNetwork();
      },
      { preconnect: blockNetwork },
    );
    const { createClient, createPasswordVerificationClient } = await import(
      "@midday/supabase/server"
    );
    const ssr = await createClient();
    if (scenario === "sdk-recovery") {
      const { createHash } = await import("node:crypto");
      const { isFreshPasswordRecovery } = await import("../password-policy");
      assert.equal(
        (
          await ssr.auth.resetPasswordForEmail(user.email, {
            redirectTo: `${origin}/api/auth/password-recovery`,
          })
        ).error,
        null,
      );
      const verifierName = "sb-supabase-auth-token-code-verifier";
      assert(cookies.get(verifierName));
      // Auth 2.118 stores a per-flow slot and index as well as the legacy
      // verifier. The default (non-experimental) redirect has no flowId, so
      // its exchange consumes only the legacy key. Other slots survive until
      // that flow is exchanged explicitly, evicted, or the session ends.
      const pendingVerifierCookies = [...cookies].filter(
        ([name]) => name.includes("code-verifier") && name !== verifierName,
      );
      assert.equal(pendingVerifierCookies.length, 2);
      // The callback is a separate request/client with the browser's cookies.
      const callback = await createClient();
      const result =
        await callback.auth.exchangeCodeForSession("fixture-pkce-code");
      assert.equal(result.error, null);
      assert.equal(result.data.session?.access_token, recoveryToken);
      // SSR awaits its auth-state storage writer: no timer/poll is needed.
      assert.equal(cookies.has(verifierName), false);
      assert(
        cookieChanges.some(
          (change) =>
            change.name === verifierName &&
            change.value === "" &&
            change.maxAge === 0 &&
            change.secure === true,
        ),
      );
      assert.deepEqual(
        [...cookies].filter(([name]) => name.includes("code-verifier")),
        pendingVerifierCookies,
      );
      const recover = requests.find((request) =>
        request.path.startsWith("/auth/v1/recover"),
      )!;
      const exchange = requests.find(
        (request) => request.path === "/auth/v1/token?grant_type=pkce",
      )!;
      assert.equal(
        new URL(recover.path, privateUrl).searchParams.get("redirect_to"),
        `${origin}/api/auth/password-recovery`,
      );
      const recoveryBody = recover.body as {
        email: string;
        code_challenge: string;
        code_challenge_method: string;
      };
      const exchangeBody = exchange.body as {
        auth_code: string;
        code_verifier: string;
      };
      assert.equal(recoveryBody.email, user.email);
      assert.equal(recoveryBody.code_challenge_method, "s256");
      assert.equal(exchangeBody.auth_code, "fixture-pkce-code");
      assert.equal(
        createHash("sha256")
          .update(exchangeBody.code_verifier)
          .digest("base64url"),
        recoveryBody.code_challenge,
      );
      const verified = await callback.auth.getClaims(
        result.data.session!.access_token,
      );
      assert.equal(verified.error, null);
      assert.equal(
        isFreshPasswordRecovery(verified.data?.claims, userId),
        true,
      );
      assert.equal(requests.length, 3);
      const replay =
        await callback.auth.exchangeCodeForSession("fixture-pkce-code");
      assert.equal(replay.error?.name, "AuthPKCECodeVerifierMissingError");
      assert.equal(replay.data.session, null);
      assert.equal(
        requests.length,
        3,
        "A consumed verifier cannot start another HTTP exchange",
      );
      // The reset action ends the recovery session. Teardown must also remove
      // all of the SDK's pending slot/index cookies, not just the legacy key.
      assert.equal(
        (await callback.auth.signOut({ scope: "local" })).error,
        null,
      );
      assert(
        ![...cookies].some(
          ([name, value]) => name.includes("code-verifier") && value,
        ),
      );
      assert.equal(requests.at(-1)?.path, "/auth/v1/logout?scope=local");
      assert.equal(requests.at(-1)?.authorization, `Bearer ${recoveryToken}`);
      assert.equal(requests.length, 4);
    } else {
      // An isolated Auth response stands in for an existing AAL2 session. This
      // test verifies real SDK storage/token behavior, not the MFA provider.
      assert.equal(
        (
          await ssr.auth.verifyOtp({
            email: user.email,
            token: "123456",
            type: "email",
          })
        ).error,
        null,
      );
      const beforeVerifier = [...cookies];
      const beforeWrites = cookieWrites;
      const verifier = createPasswordVerificationClient();
      assert.equal(
        (
          await verifier.auth.signInWithPassword({
            email: user.email,
            password: "old-fixture-password",
          })
        ).error,
        null,
      );
      assert.deepEqual([...cookies], beforeVerifier);
      assert.equal(cookieWrites, beforeWrites);
      assert.equal(
        (
          await ssr.auth.updateUser({
            password: "new-fixture-password",
            current_password: "old-fixture-password",
          })
        ).error,
        null,
      );
      assert.equal(
        (await ssr.auth.getSession()).data.session?.access_token,
        originalToken,
      );
      assert.equal(
        (await verifier.auth.signOut({ scope: "local" })).error,
        null,
      );
      assert.equal(
        (await ssr.auth.getSession()).data.session?.access_token,
        originalToken,
      );
      assert.equal(
        requests.find((request) => request.path === "/auth/v1/user")
          ?.authorization,
        `Bearer ${originalToken}`,
      );
      assert.equal(
        requests.find(
          (request) => request.path === "/auth/v1/logout?scope=local",
        )?.authorization,
        `Bearer ${verifierToken}`,
      );
      assert.deepEqual(
        requests.find((request) => request.path === "/auth/v1/user")?.body,
        {
          password: "new-fixture-password",
          current_password: "old-fixture-password",
          code_challenge: null,
          code_challenge_method: null,
        },
      );
      assert.equal(requests.length, 4);
    }
    assert(!JSON.stringify(requests).includes("must-never-be-used"));
  } else if (scenario.startsWith("proxy-")) {
    const { NextRequest: RequestClass, NextResponse } = await import(
      "next/server"
    );
    const authenticated = scenario === "proxy-mfa";
    mock.module("next-international/middleware", () => ({
      createI18nMiddleware: () => () => NextResponse.next(),
    }));
    mock.module("@midday/supabase/middleware", () => ({
      updateSession: async (_request: unknown, response: unknown) => ({
        response,
        isAuthenticated: authenticated,
        supabase: {
          auth: {
            mfa: {
              getAuthenticatorAssuranceLevel: async () => ({
                data: { currentLevel: "aal1", nextLevel: "aal2" },
              }),
            },
          },
        },
      }),
    }));
    const { proxy } = await import("../../proxy");
    if (scenario === "proxy-public") {
      for (const path of [
        "/forgot-password",
        "/en/forgot-password",
        "/reset-password",
        "/en/reset-password",
      ]) {
        const response = await proxy(new RequestClass(origin + path));
        assert.equal(response.headers.get("location"), null);
      }
    } else if (scenario === "proxy-protected") {
      const response = await proxy(
        new RequestClass(`${origin}/settings/accounts?tab=private`),
      );
      assert.equal(
        response.headers.get("location"),
        `${origin}/login?return_to=settings%2Faccounts%3Ftab%3Dprivate`,
      );
    } else {
      const response = await proxy(
        new RequestClass(`${origin}/en/reset-password`),
      );
      assert.equal(
        response.headers.get("location"),
        `${origin}/mfa/verify?return_to=reset-password`,
      );
    }
  } else if (scenario.startsWith("page-")) {
    mock.module("next/link", () => ({
      default: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
      ),
    }));
    mock.module("@midday/ui/icons", () => ({
      Icons: { LogoSmall: () => <span /> },
    }));
    mock.module("@/components/login-video-background", () => ({
      LoginVideoBackground: () => null,
    }));
    mock.module("@/components/password-recovery-request", () => ({
      PasswordRecoveryRequest: () => <form data-reset-request="true" />,
    }));
    mock.module("@/components/password-update-form", () => ({
      PasswordUpdateForm: ({ mode }: { mode: string }) => (
        <form data-password-update={mode} />
      ),
    }));
    const { renderToStaticMarkup } = await import("react-dom/server");
    if (scenario.startsWith("page-forgot-")) {
      const { default: Page } = await import(
        "../../app/[locale]/(public)/forgot-password/page"
      );
      const html = renderToStaticMarkup(
        await Page({
          searchParams: Promise.resolve({ error: "invalid_link" }),
        }),
      );
      assert.equal(
        html.includes('data-reset-request="true"'),
        scenario === "page-forgot-enabled",
      );
      if (scenario === "page-forgot-disabled")
        assert(html.includes("not enabled for this installation"));
    } else {
      const { default: Page } = await import(
        "../../app/[locale]/(public)/reset-password/page"
      );
      const html = renderToStaticMarkup(await Page());
      assert.equal(
        html.includes('data-password-update="reset"'),
        scenario === "page-reset-valid",
      );
      if (scenario !== "page-reset-valid")
        assert(html.includes("Request a new reset link"));
    }
  } else throw new Error("Unknown password fixture");
  assert.equal(calls.originalSignIn, 0);
  assert.equal(calls.setSession, 0);
  assert.equal(
    calls.ambientSession,
    0,
    "Never authorize recovery using an ambient stale session",
  );
  assert.equal(networkAttempts, 0);
  console.log(`PASSWORD_FLOWS_OK ${scenario} networkAttempts=0`);
} finally {
  clearTimeout(deadline);
}
