import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { Socket } from "node:net";

// Run in a separate Bun process without setup.ts or module mocks. The actual
// factory, private transport and Supabase SDK execute; all HTTP is in-memory.
const canonical = "https://auth.example.test";
const internal = "http://api-gw:8000";
const userId = "6ce295e8-45f5-4497-a997-4120ef988e35";
const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
};
const requests: Request[] = [];
let networkAttempts = 0;
let responseMode: "success" | "wait-for-abort" | "returned-error" = "success";
let returnedError = {
  status: 403,
  code: "not_admin",
  message: "Fixture denied",
};
const diagnostic = spyOn(console, "error").mockImplementation(() => {});

const blockNetwork = (): never => {
  networkAttempts += 1;
  throw new Error("Network is forbidden in the isolated admin deadline suite");
};
Socket.prototype.connect = blockNetwork;
globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    requests.push(request);
    if (
      request.url !== `${internal}/auth/v1/admin/users/${userId}` ||
      request.method !== "DELETE"
    ) {
      throw new Error(
        "Unexpected request in the isolated admin deadline suite",
      );
    }

    // Native fetch also rejects already-aborted requests without sending them.
    request.signal.throwIfAborted();
    if (responseMode === "wait-for-abort") {
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
      });
    }
    if (responseMode === "returned-error") {
      return Response.json(
        { code: returnedError.code, message: returnedError.message },
        {
          status: returnedError.status,
          headers: { "X-Supabase-Api-Version": "2024-01-01" },
        },
      );
    }
    return Response.json({
      user: {
        id: userId,
        email: "fixture@example.test",
        aud: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      },
    });
  },
  { preconnect: blockNetwork },
);

const { createAdminClient } = await import("../../services/supabase");

beforeEach(() => {
  requests.length = 0;
  networkAttempts = 0;
  diagnostic.mockClear();
  responseMode = "success";
  process.env.SUPABASE_URL = canonical;
  process.env.SUPABASE_INTERNAL_URL = internal;
  process.env.SUPABASE_SECRET_KEY = "fixture-admin-key-never-sent";
});

afterEach(() => {
  expect(networkAttempts).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(`${internal}/auth/v1/admin/users/${userId}`);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
  diagnostic.mockRestore();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("admin deletion deadline through the actual SDK and private transport", () => {
  test("forwards a pre-aborted signal and returns the SDK failure instead of success", async () => {
    responseMode = "wait-for-abort";
    const controller = new AbortController();
    const reason = new DOMException("Fixture canceled", "AbortError");
    controller.abort(reason);
    const client = await createAdminClient({ signal: controller.signal });
    try {
      const result = await client.auth.admin.deleteUser(userId);
      expect(result.data.user).toBeNull();
      expect(result.error?.name).toBe("AuthRetryableFetchError");
      expect(result.error?.message).toBe(reason.message);
      expect(requests[0]?.signal.aborted).toBe(true);
      expect(Object.is(requests[0]?.signal.reason, reason)).toBe(true);
      expect(diagnostic).toHaveBeenCalledTimes(1);
    } finally {
      await client.auth.stopAutoRefresh();
    }
  }, 2_000);

  test("an elapsed deadline cancels an in-flight private Auth request", async () => {
    responseMode = "wait-for-abort";
    const signal = AbortSignal.timeout(20);
    const client = await createAdminClient({ signal });
    try {
      const result = await client.auth.admin.deleteUser(userId);
      expect(signal.aborted).toBe(true);
      expect(requests[0]?.signal.aborted).toBe(true);
      expect(requests[0]?.signal.reason).toBeInstanceOf(DOMException);
      expect(requests[0]?.signal.reason.name).toBe("TimeoutError");
      expect(result.data.user).toBeNull();
      expect(result.error?.name).toBe("AuthRetryableFetchError");
      expect(diagnostic).toHaveBeenCalledTimes(1);
    } finally {
      await client.auth.stopAutoRefresh();
    }
  }, 2_000);

  test("a live signal preserves successful hard deletion and server-only headers", async () => {
    const signal = new AbortController().signal;
    const client = await createAdminClient({ signal });
    try {
      const result = await client.auth.admin.deleteUser(userId);
      expect(result.error).toBeNull();
      expect(result.data.user?.id).toBe(userId);
      expect(requests[0]?.signal.aborted).toBe(false);
      expect(requests[0]?.headers.get("apikey")).toBe(
        "fixture-admin-key-never-sent",
      );
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer fixture-admin-key-never-sent",
      );
      expect(await requests[0]?.json()).toEqual({ should_soft_delete: false });
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      await client.auth.stopAutoRefresh();
    }
  });

  for (const error of [
    { status: 403, code: "not_admin", message: "Fixture denied" },
    { status: 404, code: "user_not_found", message: "Fixture user absent" },
  ]) {
    test(`preserves returned ${error.code} errors for the caller's deletion policy`, async () => {
      responseMode = "returned-error";
      returnedError = error;
      const client = await createAdminClient({
        signal: new AbortController().signal,
      });
      try {
        const result = await client.auth.admin.deleteUser(userId);
        expect(result.data.user).toBeNull();
        expect(result.error).toMatchObject({
          name: "AuthApiError",
          status: error.status,
          code: error.code,
          message: error.message,
        });
        expect(requests[0]?.signal.aborted).toBe(false);
        expect(diagnostic).not.toHaveBeenCalled();
      } finally {
        await client.auth.stopAutoRefresh();
      }
    });
  }
});
