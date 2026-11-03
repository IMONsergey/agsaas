import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "@api/rest/types";
import type { Database } from "@midday/db/client";
import { Hono } from "hono";

const id = "33333333-3333-4333-8333-333333333333";
const actor = { userId: "11111111-1111-4111-8111-111111111111", teamId: "22222222-2222-4222-8222-222222222222", sessionId: "44444444-4444-4444-8444-444444444444" };
const db = {} as Database;
let authType: "session" | "api-key" | "oauth" = "session";
let scopes: string[] = ["chat.write", "invoices.write"];
let browserSessionId: string | undefined = actor.sessionId;
let toolName: "invoices_send" | "invoices_delete" = "invoices_send";
let status = "pending";
const preview = { invoiceId: id, revision: "exact-reviewed-revision", recipient: "customer@example.test", bcc: ["copy@example.test"], customerName: "Fixture", amount: 42, currency: "USD", invoiceNumber: "INV-1", status: "draft" };
const issue = mock(async () => ({ operation: { id: "dispatch-fixture" } }));
const remove = mock(async () => ({ id }));
const resolve = mock(async (_db: Database, checkedActor: typeof actor, checkedId: string, decision: string, execute: (db: Database, proposal: object) => Promise<unknown>) => {
  expect(checkedActor).toEqual(actor); expect(checkedId).toBe(id);
  const proposal = { id, toolName, preview, status, result: null };
  if (decision === "reject") { status = "rejected"; return { ...proposal, status }; }
  const result = await execute(db, proposal); status = "succeeded"; return { ...proposal, status, result };
});
mock.module("@midday/db/queries", () => ({
  AssistantApprovalError: class extends Error {},
  listAssistantActionApprovals: async () => [{ id, toolName, preview, status }],
  resolveAssistantActionApproval: resolve,
  issueInvoice: issue,
  deleteInvoiceWithRevision: remove,
}));
const { chatApprovalsRouter } = await import("../../rest/routers/chat-approvals");
function app() {
  const result = new Hono<Context>();
  result.use(async (c, next) => { c.set("db", db); c.set("authType", authType); c.set("teamId", actor.teamId); c.set("scopes", scopes as Context["Variables"]["scopes"]); c.set("session", { user: { id: actor.userId }, aal: "aal2", teamId: actor.teamId, sessionId: browserSessionId }); await next(); });
  result.route("/chat/approvals", chatApprovalsRouter); return result;
}
beforeEach(() => { authType = "session"; browserSessionId = actor.sessionId; scopes = ["chat.write", "invoices.write"]; toolName = "invoices_send"; status = "pending"; for (const fn of [issue, remove, resolve]) fn.mockClear(); });
describe("manual approval endpoint", () => {
  test("M2M tokens, missing browser session and missing scopes are denied before mutation", async () => {
    for (const type of ["api-key", "oauth"] as const) { authType = type; expect((await app().request(`/chat/approvals/${id}/approve`, { method: "POST" })).status).toBe(403); }
    authType = "session"; browserSessionId = undefined;
    expect((await app().request(`/chat/approvals/${id}/approve`, { method: "POST" })).status).toBe(403);
    browserSessionId = actor.sessionId; scopes = ["chat.write"];
    expect((await app().request(`/chat/approvals/${id}/approve`, { method: "POST" })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalled();
  });
  test("request body cannot replace exact stored invoice/recipient/revision", async () => {
    const response = await app().request(`/chat/approvals/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoiceId: "foreign", teamId: "foreign", sentTo: "injected@example.test", expectedRevision: "forged", approved: true }) });
    expect(response.status).toBe(200);
    expect(issue).toHaveBeenCalledWith(db, { id, teamId: actor.teamId, userId: actor.userId, deliveryType: "create_and_send", sentTo: preview.recipient, expectedRevision: preview.revision });
    expect(remove).not.toHaveBeenCalled();
  });
  test("delete passes its saved revision to the guarded command and rejection never executes", async () => {
    toolName = "invoices_delete";
    expect((await app().request(`/chat/approvals/${id}/reject`, { method: "POST" })).status).toBe(200);
    expect(issue).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    status = "pending";
    expect((await app().request(`/chat/approvals/${id}/approve`, { method: "POST" })).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(db, { id, teamId: actor.teamId, userId: actor.userId, expectedRevision: preview.revision });
  });
});
