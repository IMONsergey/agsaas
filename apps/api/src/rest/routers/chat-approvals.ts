import { withRequiredScope } from "@api/rest/middleware/scope";
import type { Context } from "@api/rest/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  AssistantApprovalError,
  deleteInvoiceWithRevision,
  issueInvoice,
  listAssistantActionApprovals,
  resolveAssistantActionApproval,
  type AssistantActionActor,
} from "@midday/db/queries";
import { InvoiceFinancialStateError } from "@midday/invoice/calculate";
import { bodyLimit } from "hono/body-limit";

const app = new OpenAPIHono<Context>();
app.use(withRequiredScope("chat.write"));
app.use(async (c, next) => {
  const session = c.get("session");
  if (c.get("authType") !== "session" || !session?.sessionId || !c.get("teamId")) {
    return c.json({ code: "SESSION_REQUIRED", error: "Sign in to review assistant actions" }, 403);
  }
  c.header("Cache-Control", "private, no-store");
  await next();
});
app.use(bodyLimit({ maxSize: 1024 }));
app.get("/", async c => {
  const session = c.get("session");
  const actor: AssistantActionActor = { userId: session.user.id, teamId: c.get("teamId"), sessionId: session.sessionId! };
  return c.json({ approvals: await listAssistantActionApprovals(c.get("db"), actor) });
});
app.post("/:id/:decision", withRequiredScope("invoices.write"), async c => {
  const id = c.req.param("id");
  const decision = c.req.param("decision");
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) || !["approve", "reject"].includes(decision)) return c.json({ error: "Invalid action" }, 400);
  const session = c.get("session");
  const actor: AssistantActionActor = { userId: session.user.id, teamId: c.get("teamId"), sessionId: session.sessionId! };
  try {
    const approval = await resolveAssistantActionApproval(c.get("db"), actor, id, decision as "approve" | "reject", async (tx, proposal) => {
      const { preview, toolName } = proposal;
      try {
        if (toolName === "invoices_send") {
          if (!preview.recipient) return { action: toolName, invoiceId: preview.invoiceId, outcome: "stale" };
          const result = await issueInvoice(tx, { id: preview.invoiceId, teamId: actor.teamId, userId: actor.userId, deliveryType: "create_and_send", sentTo: preview.recipient, expectedRevision: preview.revision });
          if (!result) return { action: toolName, invoiceId: preview.invoiceId, outcome: "stale" };
          return { action: toolName, invoiceId: preview.invoiceId, outcome: "queued", operationId: result.operation.id };
        }
        const result = await deleteInvoiceWithRevision(tx, { id: preview.invoiceId, teamId: actor.teamId, userId: actor.userId, expectedRevision: preview.revision });
        return { action: toolName, invoiceId: preview.invoiceId, outcome: result ? "deleted" : "stale" };
      } catch (error) {
        if (error instanceof InvoiceFinancialStateError) return { action: toolName, invoiceId: preview.invoiceId, outcome: "stale" };
        throw error;
      }
    });
    if (approval.status === "stale" || approval.status === "expired") return c.json({ approval, error: "The invoice or authorization changed. Request a new preview." }, 409);
    return c.json({ approval });
  } catch (error) {
    if (error instanceof AssistantApprovalError) return c.json({ error: error.message }, error.reason === "not_found" ? 404 : 400);
    throw error;
  }
});
export const chatApprovalsRouter = app;
