"use server";
import { serverApiOrigin } from "@/lib/server-api";
import { actionClient } from "./safe-action";
import { sendSupportSchema } from "./schema";

export const sendSupportAction = actionClient
  .schema(sendSupportSchema)
  .action(async ({ parsedInput }) => {
    const key = process.env.AGSAAS_SUPPORT_INGEST_KEY?.trim();
    if (!key || key.length < 32)
      throw new Error(
        "Support messaging is not configured. Contact your workspace administrator.",
      );
    const response = await fetch(`${serverApiOrigin()}/support/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(parsedInput),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "Too many requests. Please try later."
          : "Receipt could not be confirmed. Your text is preserved; retry with the same reference.",
      );
    const receipt = (await response.json()) as {
      id?: unknown;
      accepted?: unknown;
    };
    if (receipt.id !== parsedInput.requestId || receipt.accepted !== true)
      throw new Error("Receipt could not be confirmed. Please retry.");
    return { ticketId: parsedInput.requestId, accepted: true };
  });
