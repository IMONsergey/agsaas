import {
  getNotificationsSchema,
  updateAllNotificationsStatusSchema,
  updateNotificationStatusSchema,
} from "@api/schemas/notifications";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  getActivities,
  updateActivityStatus,
  updateAllActivitiesStatus,
} from "@midday/db/queries";
import { listNotificationDispatchStatus } from "@midday/db/queries/notification-dispatches";

export const notificationsRouter = createTRPCRouter({
  /** Operational state only; recipient payloads and provider receipts stay private. */
  deliveryStatus: protectedProcedure.query(({ ctx: { teamId, db } }) =>
    listNotificationDispatchStatus(db, teamId!),
  ),
  list: protectedProcedure
    .input(getNotificationsSchema.optional())
    .query(async ({ ctx: { teamId, db, session }, input }) => {
      return getActivities(db, {
        teamId: teamId!,
        userId: session.user.id,
        ...input,
      });
    }),

  updateStatus: protectedProcedure
    .input(updateNotificationStatusSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return updateActivityStatus(db, input.activityId, input.status, teamId!);
    }),

  updateAllStatus: protectedProcedure
    .input(updateAllNotificationsStatusSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      return updateAllActivitiesStatus(db, teamId!, input.status, {
        userId: session.user.id,
      });
    }),
});
