import { z } from "zod";

export const featureRequestSchema = z.object({
  email: z.string().email(),
  title: z.string().min(2, {
    message: "Title must be at least 2 characters.",
  }),
  description: z.string().min(2, {
    message: "Description must be at least 2 characters.",
  }),
  category: z.string(),
});

export const sendSupportSchema = z.object({
  requestId: z.string().uuid(),
  email: z.string().email().max(254),
  fullName: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(3).max(200),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  type: z.string().trim().min(1).max(80),
  message: z.string().trim().min(10).max(10000),
});
