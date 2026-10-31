import type {
  InvoiceOverduePayload,
  InvoicePaidPayload,
  NotificationContext,
  ProviderNotificationType,
} from "./activity-notifications";

/**
 * Pure notification formatters. Keep provider/database imports out of this
 * module so message contents can be tested without external infrastructure.
 */
export function formatNotificationContextForPrompt(
  context: NotificationContext | null | undefined,
) {
  if (!context) {
    return "";
  }

  const prompts =
    context.suggestedPrompts.length > 0
      ? ` Suggested follow-ups: ${context.suggestedPrompts.join(", ")}.`
      : "";

  return `The user's latest bot notification context is: ${context.summary}.${prompts}`;
}

export function isWithinWhatsAppSessionWindow(lastSeenAt?: string) {
  if (!lastSeenAt) {
    return false;
  }

  const seenAt = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seenAt)) {
    return false;
  }

  return Date.now() - seenAt <= 24 * 60 * 60 * 1000;
}

export function buildBatchSummary(
  type: Exclude<ProviderNotificationType, "match">,
  entries: Array<Record<string, unknown>>,
  params: {
    teamId: string;
    userId: string;
    provider: "slack" | "telegram" | "whatsapp" | "sendblue";
  },
) {
  const sentAt = new Date().toISOString();

  if (type === "transaction") {
    const transactions = entries.flatMap(
      (entry) =>
        (entry.transactions as
          | Array<{
              id: string;
              name: string;
              amount: number;
              currency: string;
              date: string;
            }>
          | undefined) ?? [],
    );

    if (transactions.length === 0) {
      return null;
    }

    const summary = `${transactions.length} new transaction${transactions.length === 1 ? "" : "s"}. Reply "show me them" and I can help review them.`;

    return {
      text: summary,
      context: {
        eventType: type,
        teamId: params.teamId,
        userId: params.userId,
        entityType: "transaction",
        entityIds: transactions.map((transaction) => transaction.id),
        summary,
        sourcePlatform: params.provider,
        suggestedPrompts: [
          "Show me them",
          "Which ones need receipts?",
          "Summarize the largest ones",
        ],
        sentAt,
      } satisfies NotificationContext,
    };
  }

  if (type === "invoice_paid") {
    const invoices = entries as Array<InvoicePaidPayload>;
    if (invoices.length === 0) {
      return null;
    }

    const invoiceLabels = invoices
      .slice(0, 3)
      .map((invoice) => invoice.invoiceNumber)
      .join(", ");
    const summary = `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} ${invoices.length === 1 ? "was" : "were"} paid${invoiceLabels ? ` (${invoiceLabels})` : ""}. Reply "show me them" to review the details.`;

    return {
      text: summary,
      context: {
        eventType: type,
        teamId: params.teamId,
        userId: params.userId,
        entityType: "invoice",
        entityIds: invoices.map((invoice) => invoice.invoiceId),
        summary,
        sourcePlatform: params.provider,
        suggestedPrompts: [
          "Show me them",
          "What's still unpaid?",
          "Summarize the cash impact",
        ],
        sentAt,
      } satisfies NotificationContext,
    };
  }

  if (type === "invoice_overdue") {
    const invoices = entries as Array<InvoiceOverduePayload>;
    if (invoices.length === 0) {
      return null;
    }

    const summary = `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} ${invoices.length === 1 ? "is" : "are"} overdue. Reply "show me them" and I can help you follow up.`;

    return {
      text: summary,
      context: {
        eventType: type,
        teamId: params.teamId,
        userId: params.userId,
        entityType: "invoice",
        entityIds: invoices.map((invoice) => invoice.invoiceId),
        summary,
        sourcePlatform: params.provider,
        suggestedPrompts: [
          "Show me them",
          "Draft a reminder",
          "Who is most overdue?",
        ],
        sentAt,
      } satisfies NotificationContext,
    };
  }

  const invoices = entries.flatMap(
    (entry) =>
      (entry.invoices as
        | Array<{
            recurringId: string;
            customerName?: string;
            amount?: number;
            currency?: string;
            scheduledAt: string;
            frequency?: string | null;
          }>
        | undefined) ?? [],
  );

  if (invoices.length === 0) {
    return null;
  }

  const summary = `${invoices.length} recurring invoice${invoices.length === 1 ? "" : "s"} ${invoices.length === 1 ? "is" : "are"} coming up soon. Reply "show me them" to review what is scheduled.`;

  return {
    text: summary,
    context: {
      eventType: type,
      teamId: params.teamId,
      userId: params.userId,
      entityType: "recurring_invoice",
      entityIds: invoices.map((invoice) => invoice.recurringId),
      summary,
      sourcePlatform: params.provider,
      suggestedPrompts: [
        "Show me them",
        "Which customers are affected?",
        "What is due soonest?",
      ],
      sentAt,
    } satisfies NotificationContext,
  };
}
