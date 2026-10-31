import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

// Run in its own Bun process, without setup.ts/jwt-fixture module mocks.
// The real API factories, JOSE verification and Supabase SDK are exercised;
// only HTTP responses are in-memory. No provider or database is contacted.
const canonical = "http://localhost:3800";
const internal = "http://api-gw:8000";
const userId = "11111111-1111-4111-8111-111111111111";
const email = "fixture@example.test";
const originalFetch = globalThis.fetch;
const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
};

process.env.SUPABASE_URL = canonical;
process.env.SUPABASE_INTERNAL_URL = internal;
process.env.SUPABASE_SECRET_KEY = "fixture-secret-key";
delete process.env.SUPABASE_JWT_SECRET;

const keys = await generateKeyPair("ES256");
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "fixture-key" };
const requests: Request[] = [];
globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.origin !== canonical && url.origin !== internal) {
      throw new Error("Unexpected origin in isolated transport test");
    }
    if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      return Response.json({ keys: [publicKey] });
    }
    if (url.pathname === "/storage/v1/object/sign/bucket/file.pdf") {
      return Response.json({
        signedURL: "/object/sign/bucket/file.pdf?token=fixture",
      });
    }
    if (url.pathname === `/auth/v1/admin/users/${userId}`) {
      return Response.json({
        user: { id: userId, email, app_metadata: {}, user_metadata: {} },
      });
    }
    if (url.pathname === "/rest/v1/users") {
      return Response.json([{ id: userId }]);
    }
    throw new Error("Unexpected route in isolated transport test");
  },
  {
    preconnect: () => {
      throw new Error("No preconnect in isolated transport test");
    },
  },
);

const { verifyAccessToken } = await import("../../utils/auth");
const { createClient, createAdminClient } = await import(
  "../../services/supabase"
);

beforeEach(() => {
  requests.length = 0;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function signToken(expired = false, privateKey = keys.privateKey) {
  return new SignJWT({
    sub: userId,
    email,
    user_metadata: { full_name: "Fixture User" },
  })
    .setProtectedHeader({ alg: "ES256", kid: "fixture-key" })
    .setIssuer(`${canonical}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (expired ? -60 : 300))
    .sign(privateKey);
}

describe("actual API internal Supabase transport wiring", () => {
  test("JWKS goes through the private transport while real signatures and cache work", async () => {
    const token = await signToken();
    expect(await verifyAccessToken(token)).toEqual({
      user: { id: userId, email, full_name: "Fixture User" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${internal}/auth/v1/.well-known/jwks.json`);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.redirect).toBe("manual");
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect((await verifyAccessToken(token))?.user.id).toBe(userId);
    expect(requests).toHaveLength(1);
  });

  test("private routing does not accept an expired signed token", async () => {
    expect(await verifyAccessToken(await signToken(true))).toBeNull();
  });

  test("private routing does not accept a token signed by another key", async () => {
    const otherKeys = await generateKeyPair("ES256");
    expect(
      await verifyAccessToken(await signToken(false, otherKeys.privateKey)),
    ).toBeNull();
  });

  test("user factory forwards the user bearer token and returns public signed URLs", async () => {
    const client = await createClient("fixture-user-token");
    const result = await client.storage
      .from("bucket")
      .createSignedUrl("file.pdf", 60);
    expect(result.error).toBeNull();
    expect(result.data?.signedUrl).toBe(
      `${canonical}/storage/v1/object/sign/bucket/file.pdf?token=fixture`,
    );
    expect(requests[0]?.url).toBe(
      `${internal}/storage/v1/object/sign/bucket/file.pdf`,
    );
    expect(requests[0]?.headers.get("apikey")).toBe("fixture-secret-key");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer fixture-user-token",
    );
    expect(await requests[0]?.json()).toEqual({ expiresIn: 60 });
  });

  test("admin factory uses private Auth transport with its server-only key", async () => {
    const client = await createAdminClient();
    try {
      const result = await client.auth.admin.getUserById(userId);
      expect(result.error).toBeNull();
      expect(result.data.user?.id).toBe(userId);
      expect(requests[0]?.url).toBe(
        `${internal}/auth/v1/admin/users/${userId}`,
      );
      expect(requests[0]?.headers.get("apikey")).toBe("fixture-secret-key");
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer fixture-secret-key",
      );
    } finally {
      await client.auth.stopAutoRefresh();
    }
  });

  test("factory uses its unchanged canonical network URL when override is unset", async () => {
    delete process.env.SUPABASE_INTERNAL_URL;
    try {
      const client = await createClient("fixture-user-token");
      const result = await client.from("users").select("id").limit(1);
      expect(result.error).toBeNull();
      expect(result.data).toEqual([{ id: userId }]);
      expect(requests[0]?.url).toBe(
        `${canonical}/rest/v1/users?select=id&limit=1`,
      );
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer fixture-user-token",
      );
    } finally {
      process.env.SUPABASE_INTERNAL_URL = internal;
    }
  });
});
