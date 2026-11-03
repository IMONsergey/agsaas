import { z } from "zod/v3";
import { getInboxIdFromEmail, type InboxEnvironment } from "./utils";

export const inboxAttachment = z
  .object({
    Name: z.string(),
    Content: z.string(),
    ContentType: z.string(),
    ContentID: z.string(),
    ContentLength: z.number(),
  })
  .passthrough();

export const createInboxWebhookPostSchema = (env?: InboxEnvironment) =>
  z
    .object({
      OriginalRecipient: z
        .string({ required_error: "OriginalRecipient is required" })
        .email({ message: "Invalid email format" })
        .refine((email) => !!getInboxIdFromEmail(email, env), {
          message:
            "Recipient must belong to this installation's configured inbox domain",
        }),
      Attachments: z.array(inboxAttachment).optional(),
      Subject: z.string().optional(),
      TextBody: z.string().optional(),
      HtmlBody: z.string().optional(),
      FromFull: z
        .object({
          Name: z.string(),
          Email: z.string(),
        })
        .passthrough(),
      MessageID: z.string({ required_error: "MessageID is required" }),
    })
    .passthrough();

export const inboxWebhookPostSchema = createInboxWebhookPostSchema();
