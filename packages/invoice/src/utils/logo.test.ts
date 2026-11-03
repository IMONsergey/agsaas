import { describe, expect, test } from "bun:test";
import {
  getPublicLogoUrl,
  isInlineLogo,
  loadPublicLogo,
  MAX_PUBLIC_LOGO_BYTES,
} from "./logo";

const origin = "https://storage.agsaas.example.test:8549";
const path =
  "/storage/v1/object/public/avatars/teams/11111111-1111-4111-8111-111111111111/invoice/logo.png";
const env = { NEXT_PUBLIC_SUPABASE_URL: origin, NODE_ENV: "production" };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
function fetcher(response: () => Response | Promise<Response>) {
  let calls = 0;
  let init: RequestInit | undefined;
  const fake = Object.assign(
    async (_input: RequestInfo | URL, options?: RequestInit) => {
      calls++;
      init = options;
      return response();
    },
    { preconnect: () => {} },
  );
  return { fetch: fake as typeof fetch, calls: () => calls, init: () => init };
}
describe("own public logos at server rendering boundaries", () => {
  test("accepts the exact configured public Storage origin and avatars bucket", () => {
    expect(getPublicLogoUrl(origin + path, env)).toBe(origin + path);
    expect(
      getPublicLogoUrl(origin + path, { NODE_ENV: "production" }),
    ).toBeNull();
  });
  test.each([
    "file:///etc/hostname",
    "http://169.254.169.254/latest/meta-data/",
    "https://cdn.midday.ai/logo.png",
    "https://foreign.example.test" + path,
    origin + "/storage/v1/object/public/vault/private.pdf",
    origin + "/storage/v1/object/sign/avatars/logo.png?token=private",
    origin + path + "?redirect=elsewhere",
    origin + path + "#fragment",
    origin + "/storage/v1/object/public/avatars/%2e%2e/vault/file.png",
    origin + "/storage/v1/object/public/avatars/%252fsecret.png",
    origin + "/storage/v1/object/public/avatars/%2fsecret.png",
    origin + "/storage/v1/object/public/avatars/%5csecret.png",
  ])("rejects an untrusted image reference without issuing a request: %s", async (input) => {
    const http = fetcher(() => {
      throw new Error("No HTTP permitted");
    });
    expect(
      await loadPublicLogo(input, { env, fetcher: http.fetch }),
    ).toBeNull();
    expect(http.calls()).toBe(0);
  });
  test("loads bounded bytes once and renders inline without forwarding a credential", async () => {
    const http = fetcher(
      () => new Response(png, { headers: { "content-type": "image/png" } }),
    );
    const result = await loadPublicLogo(origin + path, {
      env,
      fetcher: http.fetch,
    });
    expect(result).toBe("data:image/png;base64," + png.toString("base64"));
    expect(http.calls()).toBe(1);
    expect(http.init()).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    expect(http.init()?.headers).toBeUndefined();
    expect(isInlineLogo(result)).toBe(true);
  });
  test("rejects a forged image content type and SVG payload", async () => {
    for (const [body, mime] of [
      [png, "image/jpeg"],
      ["<svg/>", "image/png"],
      ["<svg/>", "image/svg+xml"],
    ] as const) {
      const http = fetcher(
        () => new Response(body, { headers: { "content-type": mime } }),
      );
      expect(
        await loadPublicLogo(origin + path, { env, fetcher: http.fetch }),
      ).toBeNull();
    }
  });
  test("bounds actual streamed bytes even without a Content-Length header", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_PUBLIC_LOGO_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const http = fetcher(
      () => new Response(stream, { headers: { "content-type": "image/png" } }),
    );
    expect(
      await loadPublicLogo(origin + path, { env, fetcher: http.fetch }),
    ).toBeNull();
    expect(cancelled).toBe(true);
  });
  test("rejects an excessive decoded image size", async () => {
    const huge = Buffer.from(png);
    huge.writeUInt32BE(100_000, 16);
    huge.writeUInt32BE(100_000, 20);
    const http = fetcher(
      () => new Response(huge, { headers: { "content-type": "image/png" } }),
    );
    expect(
      await loadPublicLogo(origin + path, { env, fetcher: http.fetch }),
    ).toBeNull();
  });
  test("cannot follow a redirect to another server route", async () => {
    let privateCalls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === path)
          return new Response(null, {
            status: 302,
            headers: { location: "/private" },
          });
        privateCalls++;
        return new Response(png, { headers: { "content-type": "image/png" } });
      },
    });
    try {
      const local = "http://127.0.0.1:" + server.port;
      expect(
        await loadPublicLogo(local + path, {
          env: { NEXT_PUBLIC_SUPABASE_URL: local, NODE_ENV: "test" },
        }),
      ).toBeNull();
      expect(privateCalls).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
  test("cancels a stalled own-origin response within its lifetime", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(png.subarray(0, 8));
            },
          }),
          { headers: { "content-type": "image/png" } },
        );
      },
    });
    try {
      const local = "http://127.0.0.1:" + server.port;
      const start = Date.now();
      expect(
        await loadPublicLogo(local + path, {
          env: { NEXT_PUBLIC_SUPABASE_URL: local, NODE_ENV: "test" },
          timeoutMs: 50,
        }),
      ).toBeNull();
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      await server.stop(true);
    }
  });
  test("refuses a cancelled operation before a request begins", async () => {
    const controller = new AbortController();
    controller.abort();
    const http = fetcher(
      () => new Response(png, { headers: { "content-type": "image/png" } }),
    );
    expect(
      await loadPublicLogo(origin + path, {
        env,
        fetcher: http.fetch,
        signal: controller.signal,
      }),
    ).toBeNull();
    expect(http.calls()).toBe(0);
  });
  test("the rendering boundary cannot accept an external URL, SVG or oversized data URI", () => {
    expect(isInlineLogo(origin + path)).toBe(false);
    expect(isInlineLogo("data:image/svg+xml;base64,PHN2Zy8+")).toBe(false);
    expect(
      isInlineLogo(
        "data:image/png;base64," + "A".repeat(MAX_PUBLIC_LOGO_BYTES * 2),
      ),
    ).toBe(false);
  });
});
