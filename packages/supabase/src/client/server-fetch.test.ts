import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type CookieOptions,
  createBrowserClient,
  createServerClient,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { getAuthCookieOptions } from "./cookie-options";
import { createSupabaseFetch, withFetchAbortSignal } from "./server-fetch";

const canonical = "https://public.example.test/supabase";
const internal = "http://api-gw:8000/private";
const originalInternal = process.env.SUPABASE_INTERNAL_URL;
type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

describe("Supabase auth cookie transport", () => {
  test.each([
    ["https://public.example.test", true],
    ["https://192.0.2.10:8545/supabase", true],
    ["http://localhost:3800", false],
    ["http://api-gw:8000/private", false],
  ] as const)("uses the canonical protocol for %s", (url, secure) => {
    expect(getAuthCookieOptions(url)).toEqual({ secure });
  });

  test.each([
    undefined,
    "",
    "not-a-url",
    "/relative",
    "ftp://public.example.test",
    "https://fixture:secret@public.example.test",
    "https://public.example.test?token=secret",
    "https://public.example.test#secret",
  ])("rejects invalid canonical config with a generic error (%s)", (url) => {
    let failure: unknown;
    try {
      getAuthCookieOptions(url);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "NEXT_PUBLIC_SUPABASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment",
    );
    expect((failure as Error).cause).toBeUndefined();
  });

  for (const kind of ["browser", "server"] as const) {
    test.each([
      {
        publicUrl: "https://192.0.2.10:8545",
        internalUrl: "http://api-gw:8000",
        cookieName: "sb-192-auth-token",
        secure: true,
      },
      {
        publicUrl: "http://localhost:3800",
        internalUrl: "https://internal.example.test",
        cookieName: "sb-localhost-auth-token",
        secure: false,
      },
    ])(`${kind} SSR writer sets and removes cookies using $publicUrl`, async ({
      publicUrl,
      internalUrl,
      cookieName,
      secure,
    }) => {
      const cookieValues = new Map<string, string>();
      const writes: {
        name: string;
        value: string;
        options: CookieOptions;
      }[] = [];
      const payload = Buffer.from(
        JSON.stringify({
          sub: "fixture-user",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url");
      const fetcher = fakeFetch(async (input) => {
        if (String(input).includes("/logout")) {
          return new Response(null, { status: 204 });
        }
        return Response.json({
          access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`,
          refresh_token: "fixture-refresh",
          token_type: "bearer",
          expires_in: 3600,
          user: {
            id: "fixture-user",
            aud: "authenticated",
            email: "fixture@example.test",
            created_at: "2030-01-01T00:00:00Z",
            app_metadata: {},
            user_metadata: {},
          },
        });
      });
      const options = {
        cookieOptions: getAuthCookieOptions(publicUrl),
        global: {
          fetch: createSupabaseFetch(publicUrl, {
            internalUrl,
            fetch: fetcher,
          }),
        },
        cookies: {
          getAll: () =>
            Array.from(cookieValues, ([name, value]) => ({ name, value })),
          setAll: (values: typeof writes) => {
            writes.push(...values);
            for (const { name, value, options } of values) {
              if (options.maxAge === 0) cookieValues.delete(name);
              else cookieValues.set(name, value);
            }
          },
        },
      };
      const client =
        kind === "browser"
          ? createBrowserClient(publicUrl, "fixture-publishable-key", {
              ...options,
              isSingleton: false,
            })
          : createServerClient(publicUrl, "fixture-publishable-key", options);

      const result = await client.auth.verifyOtp({
        email: "fixture@example.test",
        token: "123456",
        type: "email",
      });
      expect(result.error).toBeNull();
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(
        `${internalUrl}/auth/v1/verify`,
      );
      expect(cookieValues.has(cookieName)).toBe(true);
      expect(writes.length).toBeGreaterThan(0);
      for (const { name, options } of writes) {
        expect(name).toBe(cookieName);
        expect(options).toMatchObject({
          secure,
          path: "/",
          sameSite: "lax",
          httpOnly: false,
        });
      }

      writes.length = 0;
      const signedOut = await client.auth.signOut({ scope: "local" });
      expect(signedOut.error).toBeNull();
      expect(cookieValues.size).toBe(0);
      expect(writes.length).toBeGreaterThan(0);
      for (const { name, value, options } of writes) {
        expect(name).toBe(cookieName);
        expect(value).toBe("");
        expect(options).toMatchObject({
          secure,
          path: "/",
          sameSite: "lax",
          httpOnly: false,
          maxAge: 0,
        });
      }
    });
  }
});

function fakeFetch(
  handler: (
    input: FetchInput,
    init?: FetchInit,
  ) => Promise<Response> = async () => new Response("ok"),
) {
  return Object.assign(mock(handler), {
    preconnect: mock(
      (
        _url: string | URL,
        _options?: Parameters<typeof fetch.preconnect>[1],
      ) => {},
    ),
  });
}

afterEach(() => {
  if (originalInternal === undefined) delete process.env.SUPABASE_INTERNAL_URL;
  else process.env.SUPABASE_INTERNAL_URL = originalInternal;
});

describe("optional Supabase server transport", () => {
  test("unset or blank internal URL returns the original fetch unchanged", () => {
    delete process.env.SUPABASE_INTERNAL_URL;
    const fetcher = fakeFetch();
    expect(createSupabaseFetch(canonical, { fetch: fetcher })).toBe(fetcher);
    expect(
      createSupabaseFetch(canonical, { internalUrl: "", fetch: fetcher }),
    ).toBe(fetcher);
    expect(
      createSupabaseFetch(canonical, { internalUrl: "  ", fetch: fetcher }),
    ).toBe(fetcher);
  });

  test("uses the server-only env override when no explicit option was passed", async () => {
    process.env.SUPABASE_INTERNAL_URL = internal;
    const fetcher = fakeFetch();
    await createSupabaseFetch(canonical, { fetch: fetcher })(
      `${canonical}/auth/v1/user`,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${internal}/auth/v1/user`);
  });

  test.each([
    "string",
    "URL",
  ])("rewrites %s inputs while preserving path, query and options", async (kind) => {
    const fetcher = fakeFetch();
    const transport = createSupabaseFetch(canonical, {
      internalUrl: internal,
      fetch: fetcher,
    });
    const source = `${canonical}/auth/v1/verify?redirect_to=https%3A%2F%2Fdashboard.example.test%2Fcallback`;
    const input = kind === "URL" ? new URL(source) : source;
    const abort = new AbortController();
    const init = {
      method: "POST",
      headers: { apikey: "fixture-key" },
      body: "payload",
      signal: abort.signal,
    };
    await transport(input, init);
    const [routed, receivedInit] = fetcher.mock.calls[0]!;
    expect(String(routed)).toBe(source.replace(canonical, internal));
    expect(routed instanceof URL).toBe(kind === "URL");
    expect(receivedInit).toBe(init);
  });

  test("normalizes base-path trailing slashes and matches the exact base path", async () => {
    const fetcher = fakeFetch();
    const transport = createSupabaseFetch(`${canonical}/`, {
      internalUrl: `${internal}/`,
      fetch: fetcher,
    });
    await transport(`${canonical}/rest/v1/users?select=id`);
    await transport(canonical);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${internal}/rest/v1/users?select=id`,
      internal,
    ]);
  });

  test("supports root URLs and the staged localhost-to-container mapping", async () => {
    const fetcher = fakeFetch();
    await createSupabaseFetch("http://localhost:3800", {
      internalUrl: "http://api-gw:8000",
      fetch: fetcher,
    })("http://localhost:3800/auth/v1/.well-known/jwks.json");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://api-gw:8000/auth/v1/.well-known/jwks.json",
    );
  });

  test.each([
    "https://other.example.test/supabase/auth/v1/user",
    "https://public.example.test/supabase-other/auth/v1/user",
    "https://public.example.test/other",
    "http://public.example.test/supabase/auth/v1/user",
    "https://public.example.test:444/supabase/auth/v1/user",
    "https://fixture:password@public.example.test/supabase/auth/v1/user",
    "/relative-input",
  ])("does not rewrite unrelated or noncanonical request %s", async (input) => {
    const fetcher = fakeFetch();
    const transport = createSupabaseFetch(canonical, {
      internalUrl: internal,
      fetch: fetcher,
    });
    await transport(input);
    expect(fetcher.mock.calls[0]?.[0]).toBe(input);
  });

  test("passes unrelated Request objects through by identity", async () => {
    const input = new Request("https://other.example.test/object", {
      headers: { "x-test": "value" },
    });
    const init = { redirect: "manual" as const };
    const fetcher = fakeFetch();
    await createSupabaseFetch(canonical, {
      internalUrl: internal,
      fetch: fetcher,
    })(input, init);
    expect(fetcher.mock.calls[0]?.[0]).toBe(input);
    expect(fetcher.mock.calls[0]?.[1]).toBe(init);
  });

  test("preserves Request method, headers, stream body and fetch overrides", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("fixture stream payload"));
        controller.close();
      },
    });
    const input = new Request(`${canonical}/storage/v1/object/bucket/key`, {
      method: "POST",
      headers: { "x-original": "yes" },
      body: stream,
    });
    const init = {
      headers: { "x-override": "yes" },
      redirect: "manual" as const,
    };
    const fetcher = fakeFetch(async (routed, options) => {
      expect(routed).toBeInstanceOf(Request);
      const actual = routed as Request;
      expect(options).toBe(init);
      expect(actual.url).toBe(`${internal}/storage/v1/object/bucket/key`);
      expect(actual.method).toBe("POST");
      expect(actual.redirect).toBe("manual");
      expect(actual.headers.get("x-original")).toBeNull();
      expect(actual.headers.get("x-override")).toBe("yes");
      expect(await actual.text()).toBe("fixture stream payload");
      return new Response("ok");
    });
    await createSupabaseFetch(canonical, {
      internalUrl: internal,
      fetch: fetcher,
    })(input, init);
    expect(fetcher.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect(fetcher.mock.calls[0]?.[1]).toBe(init);
  });

  test("preserves Request body overrides even after the old body was consumed", async () => {
    const input = new Request(`${canonical}/auth/v1/verify`, {
      method: "POST",
      body: "old",
    });
    await input.text();
    const fetcher = fakeFetch(async (routed, init) => {
      expect(await new Request(routed, init).text()).toBe("replacement");
      return new Response("ok");
    });
    await createSupabaseFetch(canonical, {
      internalUrl: internal,
      fetch: fetcher,
    })(input, { body: "replacement" });
  });

  test.each([
    "Request",
    "init",
  ])("keeps abort propagation from %s", async (source) => {
    const abort = new AbortController();
    const reason = new Error("fixture abort");
    const fetcher = fakeFetch(async (input, init) => {
      const request = new Request(input, init);
      return new Promise<Response>((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        else
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
      });
    });
    const transport = createSupabaseFetch(canonical, {
      internalUrl: internal,
      fetch: fetcher,
    });
    const result =
      source === "Request"
        ? transport(
            new Request(`${canonical}/auth/v1/user`, { signal: abort.signal }),
          )
        : transport(`${canonical}/auth/v1/user`, { signal: abort.signal });
    abort.abort(reason);
    await expect(result).rejects.toBe(reason);
  });

  test("returns responses and rejected errors without replacing them", async () => {
    const response = new Response("fixture error response", { status: 503 });
    const fetcher = fakeFetch(async () => response);
    const transport = createSupabaseFetch(canonical, {
      internalUrl: internal,
      fetch: fetcher,
    });
    expect(await transport(`${canonical}/auth/v1/user`)).toBe(response);
    const failure = new Error("fixture fetch rejection");
    fetcher.mockRejectedValueOnce(failure);
    await expect(transport(`${canonical}/auth/v1/user`)).rejects.toBe(failure);
  });

  test("preconnect follows the same routing rules", () => {
    const fetcher = fakeFetch();
    const transport = createSupabaseFetch(canonical, {
      internalUrl: internal,
      fetch: fetcher,
    });
    const options = { dns: true, tcp: true };
    transport.preconnect(`${canonical}/auth/v1/user`, options);
    transport.preconnect("https://other.example.test", options);
    expect(String(fetcher.preconnect.mock.calls[0]?.[0])).toBe(
      `${internal}/auth/v1/user`,
    );
    expect(fetcher.preconnect.mock.calls[0]?.[1]).toBe(options);
    expect(fetcher.preconnect.mock.calls[1]?.[0]).toBe(
      "https://other.example.test",
    );
  });

  test.each([
    "not-a-url",
    "ftp://api-gw",
    "http://user:secret@api-gw",
    "http://api-gw?secret=value",
    "http://api-gw#fragment",
  ])("rejects invalid internal config without exposing the value (%s)", (internalUrl) => {
    const fetcher = fakeFetch();
    expect(() =>
      createSupabaseFetch(canonical, { internalUrl, fetch: fetcher }),
    ).toThrow(
      "SUPABASE_INTERNAL_URL must be an absolute HTTP(S) URL without credentials, query, or fragment",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("bounded Supabase fetch capability", () => {
  test.each([
    "Request",
    "init",
    "operation",
  ] as const)("retains %s cancellation through private routing", async (source) => {
    const caller = new AbortController();
    const operation = new AbortController();
    const reason = new Error("bounded fetch fixture canceled");
    const fetcher = fakeFetch(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${internal}/storage/v1/object/vault/file`);
      expect(request.headers.get("x-fixture")).toBe("kept");
      return new Promise<Response>((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        else
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
      });
    });
    const transport = withFetchAbortSignal(
      createSupabaseFetch(canonical, { internalUrl: internal, fetch: fetcher }),
      () => operation.signal,
    );
    const url = `${canonical}/storage/v1/object/vault/file`;
    const result =
      source === "Request"
        ? transport(
            new Request(url, {
              signal: caller.signal,
              headers: { "x-fixture": "kept" },
            }),
          )
        : transport(url, {
            signal: caller.signal,
            headers: { "x-fixture": "kept" },
          });
    (source === "operation" ? operation : caller).abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("retains routed preconnect without allocating a request deadline", () => {
    const fetcher = fakeFetch();
    const deadline = mock(() => new AbortController().signal);
    const transport = withFetchAbortSignal(
      createSupabaseFetch(canonical, { internalUrl: internal, fetch: fetcher }),
      deadline,
    );
    transport.preconnect(`${canonical}/storage/v1/object/vault/file`, {
      dns: true,
    });
    expect(String(fetcher.preconnect.mock.calls[0]?.[0])).toBe(
      `${internal}/storage/v1/object/vault/file`,
    );
    expect(deadline).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("real Supabase SDK with fake internal HTTP transport", () => {
  test("returns canonical signed/public Storage URLs and canonical OAuth URLs", async () => {
    const fetcher = fakeFetch(async () =>
      Response.json({ signedURL: "/object/sign/bucket/key?token=fixture" }),
    );
    const client = createClient(canonical, "fixture-publishable-key", {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: createSupabaseFetch(canonical, {
          internalUrl: internal,
          fetch: fetcher,
        }),
      },
    });
    const signed = await client.storage
      .from("bucket")
      .createSignedUrl("key", 60);
    expect(signed.error).toBeNull();
    expect(signed.data?.signedUrl).toBe(
      `${canonical}/storage/v1/object/sign/bucket/key?token=fixture`,
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `${internal}/storage/v1/object/sign/bucket/key`,
    );
    expect(
      client.storage.from("bucket").getPublicUrl("key").data.publicUrl,
    ).toBe(`${canonical}/storage/v1/object/public/bucket/key`);
    const oauth = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        skipBrowserRedirect: true,
        redirectTo: "https://dashboard.example.test/api/auth/callback",
      },
    });
    expect(oauth.error).toBeNull();
    expect(oauth.data.url?.startsWith(`${canonical}/auth/v1/authorize?`)).toBe(
      true,
    );
    expect(new URL(oauth.data.url!).searchParams.get("redirect_to")).toBe(
      "https://dashboard.example.test/api/auth/callback",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("SSR auth keeps the canonical cookie namespace while verification travels internally", async () => {
    const publicUrl = "http://localhost:3800";
    const cookieValues = new Map<string, string>();
    const fetcher = fakeFetch(async () =>
      Response.json({
        access_token: "fixture.access.token",
        refresh_token: "fixture-refresh",
        token_type: "bearer",
        expires_in: 3600,
        user: {
          id: "fixture-user",
          aud: "authenticated",
          email: "fixture@example.test",
          created_at: "2030-01-01T00:00:00Z",
          app_metadata: {},
          user_metadata: {},
        },
      }),
    );
    const client = createServerClient(publicUrl, "fixture-publishable-key", {
      global: {
        fetch: createSupabaseFetch(publicUrl, {
          internalUrl: "http://api-gw:8000",
          fetch: fetcher,
        }),
      },
      cookies: {
        getAll: () =>
          Array.from(cookieValues, ([name, value]) => ({ name, value })),
        setAll: (values) => {
          for (const { name, value } of values) cookieValues.set(name, value);
        },
      },
    });
    const result = await client.auth.verifyOtp({
      email: "fixture@example.test",
      token: "123456",
      type: "email",
    });
    expect(result.error).toBeNull();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "http://api-gw:8000/auth/v1/verify",
    );
    expect(cookieValues.has("sb-localhost-auth-token")).toBe(true);
    expect(
      Array.from(cookieValues.keys()).some((name) => name.includes("api-gw")),
    ).toBe(false);
  });
});
