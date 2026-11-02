import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Socket } from "node:net";

// Actual pinned Supabase SDK + actual API factory/private transport. No Auth
// account or network is used: only the HTTP response boundary is substituted.
const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
};
const userId = "6ce295e8-45f5-4497-a997-4120ef988e35";
const canonical = "https://mfa-fixture.example.test";
const internal = "http://api-gw:8000";
let requests: Request[] = [];
let networkAttempts = 0;
let mode:
  | "off"
  | "unverified"
  | "verified"
  | "returned-error"
  | "malformed"
  | "throw" = "off";
const diagnostics = spyOn(console, "error").mockImplementation(() => {});
const blockNetwork = (): never => {
  networkAttempts++;
  throw new Error("Network forbidden in the MFA authority suite");
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
    expect(request.url).toBe(
      internal + "/auth/v1/admin/users/" + userId + "/factors",
    );
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe(
      "Bearer fixture-admin-key-never-sent",
    );
    if (mode === "throw") throw new Error("private-transport-diagnostic");
    if (mode === "returned-error")
      return Response.json(
        { message: "private-provider-diagnostic" },
        { status: 403 },
      );
    if (mode === "malformed")
      return Response.json({ unexpected: "not-a-factor-list" });
    return Response.json(
      mode === "off"
        ? []
        : [
            {
              id: "7dd295e8-45f5-4497-a997-4120ef988e35",
              status: mode,
              factor_type: "totp",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              friendly_name: "Fixture only",
            },
          ],
    );
  },
  { preconnect: blockNetwork },
);

const { requireSessionMfa, MfaPolicyError } = await import("../../utils/mfa");
beforeEach(() => {
  requests = [];
  networkAttempts = 0;
  mode = "off";
  diagnostics.mockClear();
  process.env.SUPABASE_URL = canonical;
  process.env.SUPABASE_INTERNAL_URL = internal;
  process.env.SUPABASE_SECRET_KEY = "fixture-admin-key-never-sent";
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
  diagnostics.mockRestore();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("authoritative MFA factor policy through the actual Auth SDK", () => {
  test("MFA-off and unverified enrollment do not require AAL2", async () => {
    await requireSessionMfa({ user: { id: userId }, aal: "aal1" });
    mode = "unverified";
    await requireSessionMfa({ user: { id: userId }, aal: "aal1" });
    expect(requests).toHaveLength(2);
    expect(networkAttempts).toBe(0);
  });

  test("a verified server-side factor requires a signed AAL2 assurance", async () => {
    mode = "verified";
    await expect(
      requireSessionMfa({ user: { id: userId }, aal: "aal1" }),
    ).rejects.toMatchObject({ reason: "required" });
    await requireSessionMfa({ user: { id: userId }, aal: "aal2" });
    expect(requests).toHaveLength(1);
    expect(networkAttempts).toBe(0);
  });

  test("later factor enrollment is visible without a permissive cross-request cache", async () => {
    const session = { user: { id: userId }, aal: "aal1" as const };
    await requireSessionMfa(session);
    mode = "verified";
    await expect(requireSessionMfa(session)).rejects.toMatchObject({
      reason: "required",
    });
    expect(requests).toHaveLength(2);
    expect(networkAttempts).toBe(0);
  });

  for (const unavailable of ["returned-error", "malformed", "throw"] as const) {
    test(
      "fails closed on " + unavailable + " with generic feedback",
      async () => {
        mode = unavailable;
        let failure: unknown;
        try {
          await requireSessionMfa({ user: { id: userId }, aal: "aal1" });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(MfaPolicyError);
        expect(failure).toMatchObject({ reason: "unavailable" });
        expect((failure as Error).message).not.toContain("private-");
        expect((failure as Error).message).not.toContain("fixture-admin-key");
        expect(requests).toHaveLength(1);
        expect(networkAttempts).toBe(0);
      },
    );
  }
});
