import { expect, test } from "bun:test";
import { createServerClient } from "@supabase/ssr";
import { getAuthCookieOptions } from "./cookie-options";

test("explicit namespaces preserve secure flags and reject chunk/header ambiguity", () => {
  expect(
    getAuthCookieOptions(
      "https://94.249.186.240:8549",
      "agsaas-candidate-auth",
    ),
  ).toEqual({ secure: true, name: "agsaas-candidate-auth" });
  expect(getAuthCookieOptions("https://94.249.186.240:8545", "")).toEqual({
    secure: true,
  });
  expect(
    getAuthCookieOptions("http://127.0.0.1:14000", "agsaas-local-auth"),
  ).toEqual({ secure: false, name: "agsaas-local-auth" });
  for (const name of [
    "agsaas.0",
    " bad-name",
    "agsaas\r\nX-Header",
    "agsaas; Path=/",
    "a".repeat(81),
  ]) {
    expect(() =>
      getAuthCookieOptions("https://94.249.186.240:8549", name),
    ).toThrow("NEXT_PUBLIC_AUTH_COOKIE_NAME");
  }
});

test("actual SSR clients on two ports retain independent sessions and local logout", async () => {
  const jar = new Map<string, string>();
  const recorded: {
    name: string;
    options: { secure?: boolean; sameSite?: unknown; httpOnly?: boolean };
  }[] = [];
  const owner = "11111111-1111-4111-8111-111111111111",
    other = "22222222-2222-4222-8222-222222222222";
  function token(id: string) {
    const segment = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${segment({ alg: "HS256", typ: "JWT" })}.${segment({ sub: id, role: "authenticated", aud: "authenticated", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}.${"a".repeat(43)}`;
  }
  function client(port: number, name: string, id: string) {
    const url = `https://94.249.186.240:${port}`;
    return createServerClient(url, "synthetic-publishable-key", {
      cookieOptions: getAuthCookieOptions(url, name),
      cookies: {
        getAll: () => [...jar].map(([key, value]) => ({ name: key, value })),
        setAll(values) {
          for (const item of values) {
            if (item.value) jar.set(item.name, item.value);
            else jar.delete(item.name);
            recorded.push(item);
          }
        },
      },
      global: {
        fetch: Object.assign(
          async (input: Parameters<typeof globalThis.fetch>[0]) => {
            const endpoint =
              input instanceof Request ? input.url : String(input);
            if (endpoint.includes("/logout"))
              return new Response(null, { status: 204 });
            if (endpoint.includes("/user"))
              return Response.json({
                id,
                aud: "authenticated",
                email: "synthetic@example.test",
              });
            return Response.json({
              access_token: token(id),
              refresh_token: `synthetic-refresh-${id}`,
              token_type: "bearer",
              expires_in: 3600,
              user: {
                id,
                aud: "authenticated",
                email: "synthetic@example.test",
              },
            });
          },
          { preconnect() {} },
        ),
      },
    });
  }
  const preview = client(8545, "", owner),
    candidate = client(8549, "agsaas-candidate-20261103-auth", other);
  expect(
    (
      await preview.auth.signInWithPassword({
        email: "synthetic@example.test",
        password: "synthetic",
      })
    ).error,
  ).toBeNull();
  const original = [...jar].filter(([name]) =>
    name.startsWith("sb-94-auth-token"),
  );
  expect(original.length).toBeGreaterThan(0);
  expect(
    (
      await candidate.auth.signInWithPassword({
        email: "synthetic@example.test",
        password: "synthetic",
      })
    ).error,
  ).toBeNull();
  expect(
    (await client(8545, "", owner).auth.getSession()).data.session?.user.id,
  ).toBe(owner);
  expect(
    (
      await client(
        8549,
        "agsaas-candidate-20261103-auth",
        other,
      ).auth.getSession()
    ).data.session?.user.id,
  ).toBe(other);
  expect((await candidate.auth.signOut({ scope: "local" })).error).toBeNull();
  expect(
    [...jar].filter(([name]) => name.startsWith("sb-94-auth-token")),
  ).toEqual(original);
  expect(
    [...jar.keys()].some((name) =>
      name.startsWith("agsaas-candidate-20261103-auth"),
    ),
  ).toBeFalse();
  expect(recorded.every((item) => item.options.secure === true)).toBeTrue();
  expect(
    recorded.every(
      (item) =>
        item.options.sameSite === "lax" || item.options.sameSite === undefined,
    ),
  ).toBeTrue();
});
