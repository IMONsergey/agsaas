"use server";

import { LogEvents } from "@midday/events/events";
import { z } from "zod";
import { authActionClient } from "@/actions/safe-action";
import { getTRPCClient } from "@/trpc/server";

export const manualSyncTransactionsAction = authActionClient
  .schema(z.object({ connectionId: z.string().uuid() }).strict())
  .metadata({
    name: "manual-sync-transactions",
    track: {
      event: LogEvents.TransactionsManualSync.name,
      channel: LogEvents.TransactionsManualSync.channel,
    },
  })
  .action(async ({ parsedInput }) => {
    const client = await getTRPCClient({ forcePrimary: true });
    return client.bankSync.request.mutate(parsedInput);
  });
