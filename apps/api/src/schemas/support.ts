import { z } from "zod";
export const supportSubmissionSchema = z
  .object({
    requestId: z.string().uuid(),
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
    message: z.string().trim().min(1).max(10000),
  })
  .strict();
export const websiteSupportSchema = supportSubmissionSchema.extend({
  email: z.string().trim().email().max(320),
  fullName: z.string().trim().min(1).max(200),
});
