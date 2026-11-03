import { describe, expect, test } from "bun:test";
import type { CleanupTarget } from "@midday/db/cleanup";
import { revokeProvider } from "./resource-cleanup";

const base: CleanupTarget = {
  version: 1,
  kind: "provider",
  teamId: "11111111-1111-4111-8111-111111111111",
  actorUserId: null,
  targetId: "fixture",
  provider: "gmail",
  data: { accessToken: "fixture-secret", externalId: "fixture" },
};
const fetcher = (
  work: (url: string, init?: RequestInit) => Promise<Response>,
) => work as typeof fetch;
describe("native provider revocation outcomes", () => {
  test("Google sends the retained token only to its fixed HTTPS revoke endpoint", async () => {
    let calls = 0;
    expect(
      await revokeProvider(
        base,
        fetcher(async (url, init) => {
          calls++;
          expect(url).toBe("https://oauth2.googleapis.com/revoke");
          expect(String(init?.body)).toBe("token=fixture-secret");
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return new Response(null, { status: 200 });
        }),
      ),
    ).toEqual({ status: "completed" });
    expect(calls).toBe(1);
  });
  test("rejections, server errors and unsupported providers are never reported as successful revoke", async () => {
    expect(
      (
        await revokeProvider(
          base,
          fetcher(async () => new Response(null, { status: 400 })),
        )
      ).status,
    ).toBe("manual_required");
    expect(
      (
        await revokeProvider(
          base,
          fetcher(async () => new Response(null, { status: 503 })),
        )
      ).status,
    ).toBe("pending");
    let called = false;
    expect(
      (
        await revokeProvider(
          { ...base, provider: "outlook" },
          fetcher(async () => {
            called = true;
            throw new Error("must not call broad account session revoke");
          }),
        )
      ).status,
    ).toBe("manual_required");
    expect(called).toBe(false);
  });
  test("Slack HTTP 200 still requires its explicit revoked result", async () => {
    const target = { ...base, provider: "slack" };
    expect(
      (
        await revokeProvider(
          target,
          fetcher(async () =>
            Response.json({ ok: false, error: "invalid_auth" }),
          ),
        )
      ).status,
    ).toBe("manual_required");
    expect(
      (
        await revokeProvider(
          target,
          fetcher(async () => Response.json({ ok: true, revoked: true })),
        )
      ).status,
    ).toBe("completed");
  });
  test("Xero removes only the retained organisation connection, never its shared refresh-token grant", async () => {
    const calls: string[] = [],
      connectionId = "33333333-3333-4333-8333-333333333333";
    const result = await revokeProvider(
      {
        ...base,
        provider: "xero",
        data: { accessToken: "fixture", externalId: "tenant-fixture" },
      },
      fetcher(async (url, init) => {
        calls.push(url);
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        return Response.json([
          { id: connectionId, tenantId: "tenant-fixture" },
          { id: "other", tenantId: "another-tenant" },
        ]);
      }),
    );
    expect(result.status).toBe("completed");
    expect(calls).toEqual([
      "https://api.xero.com/connections",
      `https://api.xero.com/connections/${connectionId}`,
    ]);
  });
});
