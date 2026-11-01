import { mock } from "bun:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import type { ReactNode } from "react";

// Actual page/hook with only framework, leaf UI and Auth transport boundaries
// isolated. This is not an external provider or browser-hydration test.
const scenario = process.argv[2]!;
let networkAttempts = 0;
const blockNetwork = (): never => {
  networkAttempts++;
  throw new Error("Network forbidden in auth entry fixture");
};
globalThis.fetch = Object.assign(async () => blockNetwork(), {
  preconnect: blockNetwork,
});
Socket.prototype.connect = blockNetwork;
Bun.connect = blockNetwork;
mock.module("server-only", () => ({}));

const deadline = setTimeout(() => process.exit(124), 8000);
try {
  if (scenario.startsWith("login-")) {
    if (scenario === "login-password") {
      process.env.AUTH_ENABLED_PROVIDERS = "password";
    } else if (scenario === "login-enabled-preference") {
      process.env.AUTH_ENABLED_PROVIDERS = "email,github";
    } else {
      delete process.env.AUTH_ENABLED_PROVIDERS;
    }
    const preference =
      scenario === "login-stale-preference"
        ? "google"
        : scenario === "login-enabled-preference"
          ? "github"
          : undefined;
    mock.module("next/headers", () => ({
      cookies: async () => ({
        get: () => (preference ? { value: preference } : undefined),
      }),
    }));
    mock.module("@midday/supabase/server", () => ({
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: null }, error: null }) },
      }),
    }));
    mock.module("next/link", () => ({
      default: ({
        children,
        ...props
      }: {
        children: ReactNode;
        href: string;
      }) => <a {...props}>{children}</a>,
    }));
    mock.module("@midday/ui/icons", () => ({
      Icons: { LogoSmall: () => <span /> },
    }));
    mock.module("@/components/auth-error-toast", () => ({
      AuthErrorToast: () => null,
    }));
    mock.module("@/components/login-video-background", () => ({
      LoginVideoBackground: () => null,
    }));
    mock.module("@/components/otp-sign-in", () => ({
      OTPSignIn: () => <form data-method="email" />,
    }));
    mock.module("@/components/password-sign-in", () => ({
      PasswordSignIn: () => <form data-method="password" />,
    }));
    mock.module("@/components/oauth-sign-in", () => ({
      OAuthSignIn: ({ provider }: { provider: string }) => (
        <button type="button" data-method={provider}>
          {provider}
        </button>
      ),
    }));
    mock.module("@/components/login-accordion", () => ({
      LoginAccordion: ({ children }: { children: ReactNode }) => (
        <section data-alternatives="true">{children}</section>
      ),
    }));
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Page } = await import(
      "../../app/[locale]/(public)/login/page"
    );
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({}) }),
    );
    const methods = [...html.matchAll(/data-method="([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      methods,
      scenario === "login-password"
        ? ["password"]
        : scenario === "login-enabled-preference"
          ? ["github", "email"]
          : ["email"],
    );
    assert.equal(
      html.includes('data-alternatives="true"'),
      scenario === "login-enabled-preference",
    );
    assert(!html.includes("midday.ai"));
    assert(!html.includes("not accepting new sign-ups"));
  } else {
    const pending: boolean[] = [];
    const requests: unknown[] = [];
    const notices: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.module("react", () => ({
      useState: () => [false, (value: boolean) => pending.push(value)],
      useRef: (current: boolean) => ({ current }),
    }));
    mock.module("@midday/desktop-client/platform", () => ({
      isDesktopApp: () => false,
    }));
    mock.module("next/navigation", () => ({
      useSearchParams: () =>
        new URLSearchParams("return_to=settings%2Faccounts"),
    }));
    mock.module("@midday/ui/use-toast", () => ({
      useToast: () => ({ toast: (value: unknown) => notices.push(value) }),
    }));
    mock.module("@midday/supabase/client", () => ({
      createClient: () => ({
        auth: {
          signInWithOAuth: async (input: unknown) => {
            requests.push(input);
            if (scenario === "oauth-concurrent") await gate;
            if (scenario === "oauth-throw")
              throw new Error("PRIVATE_TRANSPORT_DIAGNOSTIC");
            return {
              data: {
                provider: "google",
                url: "https://provider.example.test/authorize",
              },
              error:
                scenario === "oauth-error"
                  ? new Error("PRIVATE_PROVIDER_DIAGNOSTIC")
                  : null,
            };
          },
        },
      }),
    }));
    const { useOAuthSignIn } = await import("../../hooks/use-oauth-sign-in");
    // biome-ignore lint/correctness/useHookAtTopLevel: This isolated fixture supplies stub React hooks to observe request cleanup.
    const hook = useOAuthSignIn("google");
    const first = hook.handleSignIn();
    if (scenario === "oauth-concurrent") {
      await hook.handleSignIn();
      assert.deepEqual(pending, [true]);
      release();
    }
    await first;
    assert.deepEqual(pending, [true, false]);
    assert.deepEqual(requests, [
      {
        provider: "google",
        options: {
          redirectTo:
            "http://127.0.0.1:3001/api/auth/callback?provider=google&return_to=settings%2Faccounts",
          scopes: undefined,
          queryParams: { prompt: "select_account" },
        },
      },
    ]);
    const failed = scenario === "oauth-error" || scenario === "oauth-throw";
    assert.equal(notices.length, failed ? 1 : 0);
    assert(!JSON.stringify(notices).includes("PRIVATE_"));
  }
  assert.equal(networkAttempts, 0);
  console.log(`AUTH_ENTRY_OK ${scenario} networkAttempts=0`);
} finally {
  clearTimeout(deadline);
}
