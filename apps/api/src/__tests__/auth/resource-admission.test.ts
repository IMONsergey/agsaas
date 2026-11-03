import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

class BudgetError extends Error {
  readonly retryAfterSeconds = 60;
}
let rejection: Error | null = null;
const consume = mock(async (..._args: unknown[]) => {
  if (rejection) throw rejection;
});
mock.module("@midday/db/queries/resource-admission", () => ({
  consumeRequestBudget: consume,
  ResourceBudgetExceededError: BudgetError,
}));
const { withResourceAdmission, admitFileRequest } = await import(
  "../../utils/resource-admission"
);
describe("authenticated request admission middleware", () => {
  beforeEach(() => {
    rejection = null;
    consume.mockClear();
  });
  const app = () => {
    const hono = new Hono();
    hono.use(async (c, next) => {
      c.set(
        "session" as never,
        { user: { id: "11111111-1111-4111-8111-111111111111" } } as never,
      );
      c.set("teamId" as never, "22222222-2222-4222-8222-222222222222" as never);
      c.set("db" as never, {} as never);
      await next();
    });
    hono.use(withResourceAdmission);
    hono.post("/chat", (c) => c.json({ businessExecuted: true }));
    return hono;
  };
  test("budget denial returns429 with retry guidance before the handler", async () => {
    rejection = new BudgetError("Workspace busy");
    const response = await app().request("/chat", { method: "POST" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).not.toHaveProperty("businessExecuted");
  });
  test("database failure fails closed, valid admission reaches the handler", async () => {
    rejection = new Error("database unavailable");
    expect((await app().request("/chat", { method: "POST" })).status).toBe(503);
    rejection = null;
    expect(
      await (await app().request("/chat", { method: "POST" })).json(),
    ).toEqual({ businessExecuted: true });
    expect(consume).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        cost: 20,
        teamId: "22222222-2222-4222-8222-222222222222",
      }),
    );
  });
  const userId = "11111111-1111-4111-8111-111111111111",
    teamId = "22222222-2222-4222-8222-222222222222",
    otherTeamId = "33333333-3333-4333-8333-333333333333";
  const fileApp = (
    ordinaryMiddleware: boolean,
    identity = { userId, teamId },
  ) => {
    const hono = new Hono();
    hono.use(async (c, next) => {
      c.set("session" as never, { user: { id: userId } } as never);
      c.set("teamId" as never, teamId as never);
      c.set("db" as never, {} as never);
      await next();
    });
    if (ordinaryMiddleware) hono.use(withResourceAdmission);
    hono.get("/file", async (c) => {
      await admitFileRequest(c, identity);
      return c.json({ fileHandlerExecuted: true });
    });
    return hono;
  };
  test("verified file identity is charged to its exact user and team before IO", async () => {
    expect((await fileApp(false).request("/file")).status).toBe(200);
    expect(consume).toHaveBeenCalledWith({}, { userId, teamId, cost: 1 });
  });
  test("ordinary middleware and the same file identity are charged once", async () => {
    expect((await fileApp(true).request("/file")).status).toBe(200);
    expect(consume).toHaveBeenCalledTimes(1);
  });
  test("a bearer budget from team A cannot cover a file key from team B", async () => {
    expect(
      (await fileApp(true, { userId, teamId: otherTeamId }).request("/file"))
        .status,
    ).toBe(200);
    expect(consume.mock.calls).toEqual([
      [{}, { userId, teamId, cost: 1 }],
      [{}, { userId, teamId: otherTeamId, cost: 1 }],
    ]);
    consume.mockClear();
    expect(
      (await fileApp(true, { userId: otherTeamId, teamId }).request("/file"))
        .status,
    ).toBe(200);
    expect(consume.mock.calls).toEqual([
      [{}, { userId, teamId, cost: 1 }],
      [{}, { userId: otherTeamId, teamId, cost: 1 }],
    ]);
  });
  test("file denial returns429 with Retry-After before its handler", async () => {
    rejection = new BudgetError("Workspace busy");
    const response = await fileApp(false).request("/file");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).not.toHaveProperty("fileHandlerExecuted");
  });
  test("file budget storage failure returns503 without reaching file IO", async () => {
    rejection = new Error("database unavailable");
    const response = await fileApp(false).request("/file");
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("fileHandlerExecuted");
  });
});
