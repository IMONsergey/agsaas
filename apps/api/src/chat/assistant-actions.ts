import type { McpContext } from "@api/mcp/types";
import {
  createAssistantActionApproval,
  getInvoiceCommandPreview,
  type AssistantAction,
  type AssistantActionActor,
} from "@midday/db/queries";
import { tool } from "ai";
import { z } from "zod";

export type AssistantToolDefinition = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };
/** Unknown or mutating tools never become executable merely because a prompt asks for confirmation. */
export function isAssistantReadTool(definition: AssistantToolDefinition) {
  return definition.annotations?.readOnlyHint === true && definition.annotations.destructiveHint !== true;
}

export function createAssistantActionTools(ctx: McpContext) {
  if (!ctx.sessionId || !ctx.scopes.includes("invoices.write")) return {};
  const actor: AssistantActionActor = { userId: ctx.userId, teamId: ctx.teamId, sessionId: ctx.sessionId };
  const propose = async (action: AssistantAction, id: string, sentTo?: string) => {
    const preview = await getInvoiceCommandPreview(ctx.db, { id, teamId: ctx.teamId, userId: ctx.userId });
    if (!preview) throw new Error("Invoice not found");
    if (action === "invoices_send") {
      if (preview.status !== "draft") throw new Error("Only a draft invoice can be proposed for sending");
      if (!preview.recipient) throw new Error("Set the invoice recipient before requesting approval");
      if (sentTo !== undefined && sentTo !== preview.recipient) throw new Error("Update the invoice recipient first, then request a new approval");
    } else if (!["draft", "canceled"].includes(preview.status)) {
      throw new Error("Only draft or canceled invoices can be proposed for deletion");
    }
    const approval = await createAssistantActionApproval(ctx.db, actor, action, preview);
    return { status: "approval_required", message: "No action was executed. The user must review the server-provided action card and press its confirmation button.", approval };
  };
  return {
    invoices_send: tool({
      description: "Prepare a send-invoice approval with its exact amount, To and BCC recipients. This tool never sends. A separate manual dashboard confirmation is required.",
      inputSchema: z.object({ id: z.string().uuid(), sentTo: z.string().email().max(320).optional() }).strict(),
      execute: ({ id, sentTo }) => propose("invoices_send", id, sentTo),
    }),
    invoices_delete: tool({
      description: "Prepare an invoice deletion approval. This tool never deletes. A separate manual dashboard confirmation is required.",
      inputSchema: z.object({ id: z.string().uuid() }).strict(),
      execute: ({ id }) => propose("invoices_delete", id),
    }),
  };
}
