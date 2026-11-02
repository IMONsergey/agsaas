"use server";

import { LogEvents } from "@midday/events/events";
import { z } from "zod";
import { sendPlainSupportMessage } from "@/utils/plain-support.server";
import { authActionClient } from "./safe-action";

export const sendFeebackAction = authActionClient
  .schema(
    z.object({
      feedback: z.string().trim().min(1).max(10_000),
    }),
  )
  .metadata({
    name: "send-feedback",
    track: {
      event: LogEvents.SendFeedback.name,
      channel: LogEvents.SendFeedback.channel,
    },
  })
  .action(async ({ parsedInput: { feedback }, ctx: { user } }) => {
    return sendPlainSupportMessage({
      kind: "feedback",
      customer: { id: user.id, email: user.email, fullName: user.fullName },
      title: "Feedback",
      message: feedback,
    });
  });
