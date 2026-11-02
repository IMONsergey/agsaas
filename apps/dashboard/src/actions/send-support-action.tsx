"use server";

import { LogEvents } from "@midday/events/events";
import { z } from "zod";
import {
  isSupportContextUrl,
  sendPlainSupportMessage,
} from "@/utils/plain-support.server";
import { authActionClient } from "./safe-action";

export const sendSupportAction = authActionClient
  .schema(
    z.object({
      subject: z.string().trim().min(1).max(200),
      priority: z.enum(["low", "normal", "high", "urgent"]),
      type: z.enum([
        "Transactions",
        "Vault",
        "Inbox",
        "Invoicing",
        "Tracker",
        "AI",
        "General",
      ]),
      message: z.string().trim().min(1).max(10_000),
      url: z
        .string()
        .max(2048)
        .refine(isSupportContextUrl, "Enter a valid HTTP(S) page URL.")
        .optional(),
    }),
  )
  .metadata({
    name: "send-support",
    track: {
      event: LogEvents.SupportTicket.name,
      channel: LogEvents.SupportTicket.channel,
    },
  })
  .action(async ({ parsedInput: data, ctx: { user } }) => {
    return sendPlainSupportMessage({
      kind: "support",
      customer: { id: user.id, email: user.email, fullName: user.fullName },
      title: data.subject,
      message: data.message,
      priority: data.priority,
      product: data.type,
      url: data.url,
    });
  });
