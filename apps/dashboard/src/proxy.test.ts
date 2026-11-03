import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest, type NextResponse } from "next/server";

const origin = "https://dashboard.agsaas.example.test:8547";
const prior = process.env.DASHBOARD_URL;
process.env.DASHBOARD_URL = origin;
let authenticated = false;
let mfaRequired = false;
let mfaCalls = 0;
let sessionCalls = 0;
mock.module("@midday/supabase/middleware", () => ({
  updateSession: async (_request: NextRequest, response: NextResponse) => {
    sessionCalls++;
    response.cookies.set("fixture-session", "refreshed", {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
    return {
      response,
      isAuthenticated: authenticated,
      supabase: {
        auth: {
          mfa: {
            getAuthenticatorAssuranceLevel: async () => {
              mfaCalls++;
              return {
                data: {
                  currentLevel: "aal1",
                  nextLevel: mfaRequired ? "aal2" : "aal1",
                },
              };
            },
          },
        },
      },
    };
  },
}));
const { proxy } = await import("./proxy");
beforeEach(() => {
  authenticated = false;
  mfaRequired = false;
  mfaCalls = 0;
  sessionCalls = 0;
});
afterAll(() => {
  if (prior === undefined) delete process.env.DASHBOARD_URL;
  else process.env.DASHBOARD_URL = prior;
});
const request = (path: string) =>
  new NextRequest(new URL(path, origin), {
    headers: { "x-forwarded-host": "foreign.example.test" },
  });
describe("dashboard session navigation", () => {
  test.each([
    "/vendor/pdfjs/5.4.296/pdf.worker.min.mjs",
    "/vendor/pdfjs/5.4.296/cmaps/Adobe-Japan1-0.bcmap",
    "/vendor/pdfjs/5.4.296/standard_fonts/LiberationSans-Regular.ttf",
    "/vendor/pdfjs/5.4.296/wasm/openjpeg.wasm",
    "/assets/bg-login.jpg",
    "/assets/bg-login-dark.jpg",
    "/appicon.png",
  ])("serves the exact public asset %s without a session or locale rewrite", async (path) => {
    const result = await proxy(request(path));
    expect(result.headers.get("location")).toBeNull();
    expect(result.headers.get("x-middleware-rewrite")).toBeNull();
    expect(result.headers.get("x-middleware-next")).toBe("1");
    expect(sessionCalls).toBe(0);
  });
  test.each([
    "/vendor/pdfjs/5.4.296/unreviewed.js",
    "/vendor/pdfjs/5.5.207/pdf.worker.min.mjs",
    "/assets/private-settings",
    "/images/private-settings",
  ])("does not exempt unlisted paths from authentication: %s", async (path) => {
    const result = await proxy(request(path));
    expect(new URL(result.headers.get("location")!).pathname).toBe("/login");
    expect(sessionCalls).toBe(1);
  });
  test("does not exempt a write request to a listed asset path", async () => {
    const result = await proxy(
      new NextRequest(new URL("/appicon.png", origin), { method: "POST" }),
    );
    expect(new URL(result.headers.get("location")!).pathname).toBe("/login");
    expect(sessionCalls).toBe(1);
  });
  test("redirects to the configured own origin and preserves refreshed cookies", async () => {
    const result = await proxy(request("/en/settings/accounts?tab=security"));
    const location = new URL(result.headers.get("location")!);
    expect(location.origin).toBe(origin);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("return_to")).toBe(
      "settings/accounts?tab=security",
    );
    expect(result.cookies.get("fixture-session")?.value).toBe("refreshed");
    expect(result.cookies.get("fixture-session")?.httpOnly).toBe(true);
  });
  test.each([
    "/login",
    "/forgot-password",
    "/reset-password",
    "/i/public-token",
    "/p/portal-id",
    "/r/report-id",
  ])("keeps the intended public entry route %s available", async (path) => {
    const result = await proxy(request(path));
    expect(result.headers.get("location")).toBeNull();
  });
  test.each([
    "/settings/i/private",
    "/settings/verify",
    "/dashboard/r/private",
  ])("does not treat a nested private path as a public route: %s", async (path) => {
    const result = await proxy(request(path));
    expect(new URL(result.headers.get("location")!).pathname).toBe("/login");
  });
  test("sends authenticated legacy invite links to Teams instead of redirecting to themselves", async () => {
    authenticated = true;
    const result = await proxy(request("/en/teams/invite/fixture"));
    expect(result.headers.get("location")).toBe(origin + "/teams");
    expect(result.cookies.get("fixture-session")?.value).toBe("refreshed");
    expect(mfaCalls).toBe(1);
  });
  test("enforces the MFA step before resolving an invite", async () => {
    authenticated = true;
    mfaRequired = true;
    const result = await proxy(request("/teams/invite/fixture"));
    const location = new URL(result.headers.get("location")!);
    expect(location.pathname).toBe("/mfa/verify");
    expect(location.searchParams.get("return_to")).toBe("teams/invite/fixture");
    expect(result.cookies.get("fixture-session")?.value).toBe("refreshed");
  });
  test("does not redirect the MFA page to itself", async () => {
    authenticated = true;
    mfaRequired = true;
    const result = await proxy(request("/mfa/verify"));
    expect(result.headers.get("location")).toBeNull();
  });
});
