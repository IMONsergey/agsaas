import { describe, expect, test } from "bun:test";
import {
  assertHealthResponse,
  assertStaticResponse,
  parseSmokeOptions,
  selectStaticAssets,
  smokeEnvironment,
} from "./smoke-dashboard";

describe("dashboard standalone smoke helpers (not a product E2E)", () => {
  test("defaults to a local standalone image and a bounded timeout", () => {
    expect(parseSmokeOptions([])).toEqual({
      appDir: "/app/apps/dashboard",
      port: 3000,
      timeoutMs: 30_000,
    });
    expect(
      parseSmokeOptions(["--port", "3456", "--timeout-ms", "60000"]),
    ).toMatchObject({ port: 3456, timeoutMs: 60_000 });
  });
  test.each(
    [
      ["--port", "0"],
      ["--port", "65536"],
      ["--port", "30junk"],
      ["--timeout-ms", "0"],
      ["--timeout-ms", "60001"],
      ["--port"],
      ["--port", "3000", "--port", "3001"],
      ["--base-url", "https://secret-must-not-appear.invalid"],
    ].map((args) => ({ args })),
  )("rejects invalid or remote options without echoing values", ({ args }) => {
    expect(() => parseSmokeOptions(args)).toThrow();
    try {
      parseSmokeOptions(args);
    } catch (error) {
      expect(String(error)).not.toContain("secret-must-not-appear");
    }
  });
  test("the server environment is a small allowlist without provider secrets or endpoint overrides", () => {
    const env = smokeEnvironment(
      {
        PATH: "/usr/bin",
        SUPABASE_SECRET_KEY: "secret-must-not-appear",
        DATABASE_PRIMARY_URL: "secret-must-not-appear",
        NODE_OPTIONS: "secret-must-not-appear",
        BUN_OPTIONS: "secret-must-not-appear",
        NEXT_PUBLIC_API_URL: "secret-must-not-appear",
        NEXT_PUBLIC_SUPABASE_URL: "secret-must-not-appear",
        SENTRY_AUTH_TOKEN: "secret-must-not-appear",
        NEXT_PUBLIC_SENTRY_DSN: "secret-must-not-appear",
        HTTPS_PROXY: "secret-must-not-appear",
        PORT: "9999",
      },
      3456,
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: "3456",
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    });
    expect(JSON.stringify(env)).not.toContain("secret-must-not-appear");
  });
  test("selects actual JS and CSS, not sourcemaps or placeholder pages", () => {
    expect(
      selectStaticAssets([
        "chunks/b.js",
        "chunks/a.js",
        "css/main.css",
        "main.js.map",
        "index.html",
      ]),
    ).toEqual({ script: "chunks/a.js", stylesheet: "css/main.css" });
    expect(() => selectStaticAssets(["main.js.map", "index.html"])).toThrow(
      "real Next.js",
    );
    expect(() => selectStaticAssets(["main.js"])).toThrow("real Next.js");
  });
  test("accepts the real health response contract", async () => {
    await expect(
      assertHealthResponse(Response.json({ status: "ok" })),
    ).resolves.toBeUndefined();
  });
  test.each([
    () => Response.json({ status: "ok" }, { status: 503 }),
    () =>
      new Response("secret-must-not-appear", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    () => Response.json({ status: "secret-must-not-appear" }),
    () =>
      new Response("secret-must-not-appear", {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://secret-must-not-appear.invalid" },
      }),
  ])("rejects unhealthy, malformed, or redirected health without leaking response bodies", async (response) => {
    try {
      await assertHealthResponse(response());
      throw new Error("Unexpected successful probe");
    } catch (error) {
      expect(String(error)).not.toContain("secret-must-not-appear");
      expect(String(error)).not.toContain("Unexpected successful probe");
    }
  });
  test.each([
    "application/javascript",
    "text/javascript",
  ])("accepts byte-identical JavaScript served as %s", async (type) => {
    const bytes = new TextEncoder().encode("console.log('fixture');");
    await expect(
      assertStaticResponse(
        new Response(bytes, {
          headers: { "content-type": `${type}; charset=utf-8` },
        }),
        bytes,
        "script",
      ),
    ).resolves.toBeUndefined();
  });
  test("accepts byte-identical CSS", async () => {
    const bytes = new TextEncoder().encode("body{color:black}");
    await expect(
      assertStaticResponse(
        new Response(bytes, { headers: { "content-type": "text/css" } }),
        bytes,
        "stylesheet",
      ),
    ).resolves.toBeUndefined();
  });
  test.each([
    () =>
      new Response("expected", {
        status: 404,
        headers: { "content-type": "text/css" },
      }),
    () =>
      new Response("expected", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("wrong bytes", { headers: { "content-type": "text/css" } }),
    () => new Response(null, { status: 307 }),
  ])("rejects missing, redirected, or mismatched static assets", async (response) => {
    await expect(
      assertStaticResponse(
        response(),
        new TextEncoder().encode("expected"),
        "stylesheet",
      ),
    ).rejects.toThrow();
  });
  test("empty files cannot pass static verification", async () => {
    await expect(
      assertStaticResponse(
        new Response("", { headers: { "content-type": "text/css" } }),
        new Uint8Array(),
        "stylesheet",
      ),
    ).rejects.toThrow("differs");
  });
});
