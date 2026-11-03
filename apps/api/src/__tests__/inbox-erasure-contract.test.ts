import { afterAll, describe, expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMiddleware } from "hono/factory";
import type { McpContext } from "../mcp/types";
import type { Context } from "../rest/types";

const id = "0c3c332b-d2db-4488-965f-e1087c285db9";
const teamId = "9136f10f-419f-4ae1-9cf0-f99c23c37085";
const cleanupId = "81852bb8-2088-42b5-ae5d-4c06bdc46a36";
const command = {
  id,
  deleted: true as const,
  status: "deleted" as const,
  cleanupPending: true,
  cleanupId,
};
const calls: unknown[] = [];
const update = mock(
  async (
    _db: unknown,
    input: { id: string; teamId: string; status?: string },
  ) => {
    calls.push(input);
    return input.id === id ? command : undefined;
  },
);
const forbidden = () => {
  throw new Error(
    "External IO is forbidden in the Inbox erasure contract test",
  );
};
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => forbidden(), {
  preconnect: forbidden,
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
mock.module("@midday/db/queries", () => ({
  updateInbox: update,
  deleteInbox: async () => command,
  getInbox: async () => ({ data: [], meta: {} }),
  getInboxById: async () => undefined,
  confirmSuggestedMatch: forbidden,
  declineSuggestedMatch: forbidden,
  matchTransaction: forbidden,
  unmatchTransaction: forbidden,
}));
mock.module("@api/services/supabase", () => ({ createAdminClient: forbidden }));
mock.module("@midday/supabase/storage", () => ({
  signedUrl: forbidden,
  download: forbidden,
}));
mock.module("@midday/utils/envs", () => ({
  getAppUrl: () => "https://app.example.test",
}));
// Authentication/scopes are separate gates; this suite exercises the real response contract.
mock.module("../rest/middleware", () => ({
  withRequiredScope: () =>
    createMiddleware<Context>(async (_context, next) => {
      await next();
    }),
}));
const { inboxRouter } = await import("../rest/routers/inbox");
const { registerInboxTools } = await import("../mcp/tools/inbox");
const { inboxErasureResponseSchema } = await import("../schemas/inbox");
const app = new OpenAPIHono<Context>();
const db = {} as Context["Variables"]["db"];
app.use("*", async (c, next) => {
  c.set("db", db);
  c.set("teamId", teamId);
  await next();
});
app.route("/inbox", inboxRouter);

describe("Inbox physical erasure command response", () => {
  test("REST PATCH status deleted returns HTTP 200 and the cleanup receipt without PII", async () => {
    const result = await app.request("http://test/inbox/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(command);
    expect(calls.at(-1)).toEqual({ id, teamId, status: "deleted" });
    expect(
      inboxErasureResponseSchema.safeParse({
        ...command,
        fileName: "erased.pdf",
      }).success,
    ).toBe(false);
  });

  test("REST DELETE also preserves pending cleanup status and its recovery ID", async () => {
    const result = await app.request("http://test/inbox/" + id, {
      method: "DELETE",
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(command);
  });

  test("MCP inbox_update returns a successful erasure receipt, not not-found or former detail fields", async () => {
    type Handler = (input: Record<string, unknown>) => Promise<{
      isError?: boolean;
      structuredContent?: unknown;
      content?: unknown;
    }>;
    const handlers = new Map<string, Handler>();
    const annotations = new Map<string, { destructiveHint?: boolean }>();
    const server = {
      registerTool(
        name: string,
        config: { annotations?: { destructiveHint?: boolean } },
        handler: Handler,
      ) {
        handlers.set(name, handler);
        annotations.set(name, config.annotations ?? {});
      },
    } as unknown as McpServer;
    const context: McpContext = {
      db,
      teamId,
      userId: "f14b9ced-b76b-4c4a-8fe7-d24c097d0d6d",
      userEmail: null,
      scopes: ["inbox.write"],
      apiUrl: "https://api.example.test",
      timezone: null,
      locale: null,
      countryCode: null,
      dateFormat: null,
      timeFormat: null,
    };
    registerInboxTools(server, context);
    const result = await handlers.get("inbox_update")!({
      id,
      status: "deleted",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ data: command });
    expect(annotations.get("inbox_update")?.destructiveHint).toBe(true);
    const removed = await handlers.get("inbox_delete")!({ id });
    expect(removed.isError).not.toBe(true);
    expect(removed.structuredContent).toEqual({
      ...command,
      success: true,
      deletedId: id,
    });
    expect(JSON.stringify(result)).not.toContain("filePath");
    expect(JSON.stringify(result)).not.toContain("transaction");
  });
});
