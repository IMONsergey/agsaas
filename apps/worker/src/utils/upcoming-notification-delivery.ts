import type { Database } from "@midday/db/client";
import {
  getInvoiceRecurringById,
  markUpcomingNotificationSent,
} from "@midday/db/queries";
import { Notifications } from "@midday/notifications";
import { z } from "zod";
import { dispatchNotificationEmail } from "./notification-dispatch";

export const upcomingNotificationDispatchSchema = z
  .object({
    teamId: z.string().uuid(),
    recurringId: z.string().uuid(),
    nextScheduledAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** Identity belongs to one series occurrence, independent of scheduler batch
 * membership. A failed marker write or later additional series cannot replay
 * the accepted recipients of a previous batch. */
export async function deliverUpcomingNotification(
  db: Database,
  input: z.infer<typeof upcomingNotificationDispatchSchema>,
) {
  const payload = upcomingNotificationDispatchSchema.parse({
    ...input,
    nextScheduledAt: new Date(input.nextScheduledAt).toISOString(),
  });
  const sourceJobId = `recurring-upcoming/${payload.recurringId}/${new Date(payload.nextScheduledAt).toISOString()}`;
  let series: Awaited<ReturnType<typeof getInvoiceRecurringById>> = null;
  const notifications = new Notifications(db);
  const data = () => {
    if (!series) throw new Error("Upcoming notification has no current series");
    return {
      invoices: [
        {
          recurringId: series.id,
          customerName: series.customerName ?? undefined,
          amount: series.amount ?? undefined,
          currency: series.currency ?? undefined,
          scheduledAt: payload.nextScheduledAt,
          frequency: series.frequency,
        },
      ],
      count: 1,
    };
  };
  const result = await dispatchNotificationEmail({
    db,
    kind: "recurring-upcoming",
    sourceJobId,
    payload,
    isCurrent: async () => {
      // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
      series = await getInvoiceRecurringById(db.usePrimaryOnly() as Database, {
        id: payload.recurringId,
        teamId: payload.teamId,
      });
      return Boolean(
        series &&
          series.status === "active" &&
          series.nextScheduledAt &&
          Date.parse(series.nextScheduledAt) ===
            Date.parse(payload.nextScheduledAt) &&
          Date.parse(payload.nextScheduledAt) > Date.now(),
      );
    },
    createActivities: async (activityOperationKey) =>
      (
        await notifications.create(
          "recurring_invoice_upcoming",
          payload.teamId,
          data(),
          { sendEmail: false, activityOperationKey },
        )
      ).activities,
    send: () =>
      notifications.create(
        "recurring_invoice_upcoming",
        payload.teamId,
        data(),
        { sendEmail: true, skipActivities: true },
      ),
  });
  // A ledger receipt is the authority. If this marker write fails, a later
  // attempt reuses the receipt and retries only the marker, never the email.
  await markUpcomingNotificationSent(db, {
    id: payload.recurringId,
    teamId: payload.teamId,
    expectedNextScheduledAt: payload.nextScheduledAt,
  });
  return result;
}
