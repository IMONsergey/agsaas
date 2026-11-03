import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { Context } from "@api/rest/types";

// Isolated process: exercise the real HTTP route while substituting only IO.
const savedKey = process.env.OPENAI_API_KEY;
const uploads: unknown[] = [];
const runs: Array<{ allowExternalTools?: boolean }> = [];
let decoded = 0;
mock.module("@api/chat/assistant-runtime", () => ({ streamMiddayAssistant: async (params: { allowExternalTools?: boolean }) => { runs.push(params); return { toUIMessageStream: () => ({}) }; } }));
mock.module("@api/chat/utils", () => ({ decodeDataUrl: () => { decoded++; return { data: new Uint8Array([1]), mediaType: "application/pdf" }; }, stripFileAndImageParts: () => {}, writeChatTitle: async () => {} }));
mock.module("@api/utils/geo", () => ({ getGeoContext: () => ({}) }));
mock.module("@midday/bot", () => ({ formatProcessedUploadSummary: () => "Uploaded", getPlatformInstructions: () => "", isSupportedInboxUploadMediaType: (type: string) => type === "application/pdf", processInboxUpload: async (params: unknown) => { uploads.push(params); return {}; } }));
mock.module("ai", () => ({ convertToModelMessages: async (messages: unknown) => messages, createUIMessageStream: ({ execute }: { execute: (args: unknown) => Promise<void> }) => execute({ writer: { write() {}, merge() {} } }), createUIMessageStreamResponse: async ({ stream }: { stream: Promise<void> }) => { await stream; return new Response("fixture-stream"); } }));
const { chatRouter } = await import("../../rest/routers/chat");

const textMessage = { id: "one", role: "user", parts: [{ type: "text", text: "Hello" }] };
const fileMessage = { id: "two", role: "user", parts: [{ type: "file", mediaType: "application/pdf", filename: "receipt.pdf", url: "data:application/pdf;base64,AQ==" }] };
function request(scopes: Context["Variables"]["scopes"], authType: Context["Variables"]["authType"], body: unknown = { messages: [textMessage] }) {
  const app = new Hono<Context>();
  app.use("*", async (c, next) => {
    c.set("db", {} as Context["Variables"]["db"]);
    c.set("teamId", "00000000-0000-4000-8000-000000000001");
    c.set("session", { user: { id: "fixture-user" } });
    if (scopes) c.set("scopes", scopes);
    if (authType) c.set("authType", authType);
    await next();
  });
  app.route("/chat", chatRouter);
  return app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
beforeEach(() => { process.env.OPENAI_API_KEY = "fixture-not-a-real-key"; uploads.length = 0; runs.length = 0; decoded = 0; });
afterAll(() => { if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey; });

describe("chat authorization precedes privileged IO", () => {
  test("read-only credentials fail before even parsing malformed JSON", async () => {
    const response = await request(["transactions.read"], "api-key", "invalid JSON");
    expect(response.status).toBe(403);
    expect(uploads).toHaveLength(0); expect(runs).toHaveLength(0); expect(decoded).toBe(0);
  });
  test("absent scopes fail closed", async () => {
    const response = await request(undefined, "session", "invalid JSON");
    expect(response.status).toBe(401);
    expect(runs).toHaveLength(0);
  });
  test("AI readiness is checked after scope and before parsing or uploads", async () => {
    delete process.env.OPENAI_API_KEY;
    expect((await request(["transactions.read"], "api-key", "invalid JSON")).status).toBe(403);
    const response = await request(["chat.write", "inbox.write"], "session", "invalid JSON");
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("AI_NOT_CONFIGURED");
    expect(uploads).toHaveLength(0); expect(runs).toHaveLength(0); expect(decoded).toBe(0);
  });
  test("chat permission alone cannot write an inbox attachment", async () => {
    const response = await request(["chat.write"], "oauth", { messages: [fileMessage] });
    expect(response.status).toBe(403);
    expect(uploads).toHaveLength(0); expect(runs).toHaveLength(0); expect(decoded).toBe(0);
  });
  for (const authType of ["api-key", "oauth"] as const) {
    test(`${authType} cannot delegate personal connector tools even with request-body spoofing`, async () => {
      const response = await request(["chat.write", "inbox.write"], authType, { messages: [fileMessage], allowExternalTools: true });
      expect(response.status).toBe(200);
      expect(uploads).toHaveLength(1);
      expect(runs[0]?.allowExternalTools).toBe(false);
    });
  }
  test("verified interactive sessions retain explicitly delegated connectors", async () => {
    expect((await request(["chat.write"], "session")).status).toBe(200);
    expect(runs[0]?.allowExternalTools).toBe(true);
  });
  test("malformed messages are a client error with no provider work", async () => {
    expect((await request(["chat.write"], "session", { messages: null })).status).toBe(400);
    expect(runs).toHaveLength(0);
  });
});
